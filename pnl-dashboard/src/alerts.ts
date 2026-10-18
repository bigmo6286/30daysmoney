/**
 * Range alerts for Dashboard Pro, run by the shop workflow right after checkout's tick:
 *   DATA_DIR=../checkout/data SHOP_TG_TOKEN=… npm run alerts
 *
 * Reads the watch list the shop bot keeps (watches.json), reads each wallet's Uniswap v3 (Robinhood,
 * Base, Arbitrum) and v4 (Robinhood) positions, and DMs the watcher when a position leaves its
 * range or comes back. The first read of a wallet only records the ranges. A wallet whose read
 * fails on any chain is skipped for this run, so a dead RPC never reads as "out of range".
 */
import path from "node:path";
import { ethers } from "ethers";
import { V3_CHAINS, V4_CHAINS } from "./chains";
import { readV3Positions, v3Rows } from "./sources/univ3";
import { readV4Positions } from "./sources/univ4";
import type { Row } from "./model";
import { readJson, writeJsonAtomic } from "./store";

export interface Watch {
  chatId: number;
  address: string;
}

/** per wallet: when it was last read, and each open position's in-range state */
export interface WalletState {
  at: number;
  pos: Record<string, { inRange: boolean; label: string }>;
}

export interface Alert {
  chatId: number;
  text: string;
}

const EVERY_MS = 15 * 60_000;
const MAX_WALLETS_PER_RUN = 8;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Positions as `chain|id` → state, from one wallet's rows (positions without a range state are left out). */
export function snapshot(rows: Row[]): WalletState["pos"] {
  const out: WalletState["pos"] = {};
  for (const r of rows) if (r.status === "open" && r.inRange !== undefined) out[`${r.chain}|${r.id}`] = { inRange: r.inRange, label: `${r.pair} on ${r.chain}` };
  return out;
}

/** What changed between two reads of a wallet. Nothing on the first read; new and closed positions are silent. */
export function changes(prev: WalletState | undefined, now: WalletState["pos"]): { label: string; inRange: boolean }[] {
  if (!prev) return [];
  const out: { label: string; inRange: boolean }[] = [];
  for (const [k, p] of Object.entries(now)) {
    const was = prev.pos[k];
    if (was && was.inRange !== p.inRange) out.push(p);
  }
  return out;
}

export function alertText(address: string, c: { label: string; inRange: boolean }, dashboardUrl?: string): string {
  const where = `<b>${c.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</b> (${short(address)})`;
  const body = c.inRange
    ? `✅ Back in range: ${where}. It's earning fees again.`
    : `⚠️ Out of range: ${where}. It earns no fees until the price comes back or you rebalance.`;
  return dashboardUrl ? `${body}\n${dashboardUrl}` : body;
}

export type ReadWallet = (address: string) => Promise<Row[]>;

/** One alerts pass: due wallets only, oldest first, at most MAX_WALLETS_PER_RUN. Returns the alerts and the new state. */
export async function runAlerts(watches: Watch[], state: Record<string, WalletState>, read: ReadWallet, now = Date.now(), dashboardUrl?: string) {
  const alerts: Alert[] = [];
  const next = { ...state };
  const byWallet = new Map<string, number[]>();
  for (const w of watches) byWallet.set(w.address.toLowerCase(), [...(byWallet.get(w.address.toLowerCase()) ?? []), w.chatId]);
  // forget wallets nobody watches any more
  for (const a of Object.keys(next)) if (!byWallet.has(a)) delete next[a];
  const due = [...byWallet.keys()].filter((a) => !next[a] || now - next[a]!.at >= EVERY_MS).sort((a, b) => (next[a]?.at ?? 0) - (next[b]?.at ?? 0)).slice(0, MAX_WALLETS_PER_RUN);
  const failed: string[] = [];
  for (const a of due) {
    let rows: Row[];
    try {
      rows = await read(a);
    } catch {
      failed.push(a);
      continue;
    }
    const pos = snapshot(rows);
    for (const c of changes(next[a], pos)) for (const chatId of byWallet.get(a)!) alerts.push({ chatId, text: alertText(a, c, dashboardUrl) });
    next[a] = { at: now, pos };
  }
  return { alerts, state: next, checked: due.length - failed.length, failed };
}

/** Reads a wallet on every chain; throws if any chain's read fails (so the caller skips it). */
export function chainReader(env: NodeJS.ProcessEnv = process.env): ReadWallet {
  const key = (env.ALCHEMY_KEY || "").trim();
  const providers = new Map<string, ethers.JsonRpcProvider>();
  const provider = (url: string, chainId: number) => {
    if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true }));
    return providers.get(url)!;
  };
  return async (owner) => {
    const rows: Row[] = [];
    for (const { alchemy, ...c } of Object.values(V3_CHAINS)) {
      const url = key ? `https://${alchemy}.g.alchemy.com/v2/${key}` : c.rpcUrl;
      rows.push(...v3Rows(c, owner, await readV3Positions(c, owner, provider(url, c.chainId))));
    }
    // v4 finds positions from Transfer logs over 10M-block windows: the public RPC allows that, Alchemy's free tier doesn't
    for (const c of Object.values(V4_CHAINS)) rows.push(...v3Rows(c, owner, await readV4Positions(c, owner, provider(c.rpcUrl, c.chainId))).map((r) => ({ ...r, pair: `${r.pair} · v4` })));
    return rows;
  };
}

async function main() {
  const dir = path.resolve(process.env.DATA_DIR || "data");
  const token = (process.env.SHOP_TG_TOKEN || "").trim();
  if (!token) throw new Error("SHOP_TG_TOKEN is required (alerts go out through the shop bot)");
  const watches = readJson<{ watches: Watch[] }>(path.join(dir, "watches.json"), { watches: [] }).watches;
  const stateFile = path.join(dir, "alerts.json");
  const store = (process.env.STORE_URL || "").trim();
  const r = await runAlerts(watches, readJson(stateFile, {}), chainReader(), Date.now(), store ? `${store.replace(/\/?$/, "/")}dashboard/` : undefined);
  writeJsonAtomic(stateFile, r.state);
  for (const a of r.alerts) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: a.chatId, text: a.text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => e);
    if (res instanceof Error || !res.ok) console.warn(`alert to ${a.chatId} failed: ${res instanceof Error ? res.message : res.status}`);
  }
  console.log(`alerts: ${watches.length} watches, ${r.checked} wallets read, ${r.failed.length} failed, ${r.alerts.length} alerts sent`);
}

if (process.argv[1]?.endsWith("alerts.ts")) main().catch((e) => {
  console.error(`alerts: ${(e as Error).message}`);
  process.exit(1);
});
