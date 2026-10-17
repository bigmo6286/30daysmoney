/**
 * Our bots' own position books: exact cost basis and realized PnL, because the bot recorded
 * every deposit and close. Read-only; the files are written by the bots.
 */
import path from "node:path";
import { readJson } from "../store";
import type { Row } from "../model";

const eth = (wei: string | undefined) => (wei ? Number(BigInt(wei)) / 1e18 : 0);

/** lp-bot data/positions.json (Uniswap v3 on an EVM chain; amounts in wei of ETH) */
export function lpBotRows(dataDir: string, chain: string): Row[] {
  const b = readJson<{ open?: Record<string, any>; closed?: any[] }>(path.join(dataDir, "positions.json"), {});
  const rows: Row[] = [];
  for (const r of Object.values(b.open ?? {})) {
    rows.push({
      source: "lp-bot",
      chain,
      id: String(r.id),
      pair: `${r.symbol}/ETH ${r.fee / 10_000}%`,
      status: "open",
      unit: "ETH",
      paper: r.kind === "paper",
      depositNative: eth(r.depositQuote),
      feesNative: undefined,
      openedAt: r.openedAt,
      inRange: r.inRange,
      extra: { collectedNative: eth(r.collectedQuote), leftoverRaw: r.leftoverToken, tokenDecimals: r.tokenDecimals },
      note: r.kind === "paper" ? "paper: live value in the bot's /list" : undefined,
    });
  }
  for (const r of b.closed ?? []) {
    rows.push({
      source: "lp-bot",
      chain,
      id: String(r.id),
      pair: `${r.symbol}/ETH ${r.fee / 10_000}%`,
      status: "closed",
      unit: "ETH",
      paper: r.kind === "paper",
      depositNative: eth(r.depositQuote),
      valueNative: eth(r.realizedQuote),
      feesNative: eth(r.feesQuote),
      pnlNative: eth(r.pnlQuote),
      pnlPct: r.pnlPct,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      note: r.reason,
    });
  }
  return rows;
}

/** dlmm-agent data/positions.json (Meteora DLMM on Solana; amounts in SOL) */
export function dlmmRows(dataDir: string): Row[] {
  const b = readJson<{ open?: any[]; closed?: any[] }>(path.join(dataDir, "positions.json"), {});
  const rows: Row[] = [];
  for (const r of b.open ?? []) {
    const paper = String(r.position).startsWith("paper-");
    rows.push({
      source: "dlmm-agent",
      chain: "solana",
      id: paper ? `#${r.id}` : String(r.position),
      pair: `${r.symbol}/SOL`,
      status: "open",
      unit: "SOL",
      paper,
      depositNative: r.depositSol,
      openedAt: r.openedAt,
      note: paper ? "paper: live value in the agent's /status" : undefined,
    });
  }
  for (const r of b.closed ?? []) {
    rows.push({
      source: "dlmm-agent",
      chain: "solana",
      id: String(r.position).startsWith("paper-") ? `#${r.id}` : String(r.position),
      pair: `${r.symbol}/SOL`,
      status: "closed",
      unit: "SOL",
      paper: String(r.position).startsWith("paper-"),
      depositNative: r.spentSol,
      valueNative: r.receivedSol,
      pnlNative: r.pnlSol,
      pnlPct: r.pnlPct,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      note: r.reason,
    });
  }
  return rows;
}
