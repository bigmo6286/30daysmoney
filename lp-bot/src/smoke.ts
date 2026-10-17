/**
 * `npm run smoke`: one pass against the configured chain without Telegram and without signing.
 * RPC + chain id → Telegram token check (getMe, no message) → Swap-log scan → round trip, Jev
 * and a paper open/value/close on the deepest pools. Run after install (and by the setup service)
 * to prove RPC, contracts and keys all work before the bot is left running.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { loadConfig, SettingsStore } from "./config";
import { Chain } from "./chain/client";
import { PositionBook } from "./lp/positions";
import { LpService } from "./lp/service";
import { Telegram } from "./bot/telegram";
import { Scanner } from "./auto/scanner";
import { Autopilot } from "./auto/autopilot";
import { CachedScreener } from "./auto/screen";
import { JevScreener } from "./auto/jev";

const TRY = 5;

async function main() {
  // paper only, on a throwaway data dir: the real book, settings and scanner index are never touched
  const cfg = loadConfig({ ...process.env, MODE: "paper", TG_TOKEN: process.env.TG_TOKEN || "0:smoke", TG_OWNER_ID: process.env.TG_OWNER_ID || "0" });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lpbot-smoke-"));
  const out = (l: string) => console.log(l.replace(/<[^>]+>/g, ""));
  const step = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      const r = await f();
      out(`✓ ${name} (${Date.now() - t0} ms)`);
      return r;
    } catch (e) {
      out(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  };

  const chain = new Chain(cfg);
  await step(`RPC ${new URL(cfg.rpcUrl).host} is ${cfg.chain.name}`, async () => {
    const id = Number((await chain.provider.send("eth_chainId", [])) as string);
    if (id !== cfg.chain.chainId) throw new Error(`RPC is chain ${id}, expected ${cfg.chain.chainId}`);
  });
  if (process.env.TG_TOKEN) {
    const me = await step("Telegram token", () => new Telegram(cfg.tgToken, cfg.tgOwnerId).call<{ username: string }>("getMe", {}));
    out(`  bot @${me.username}, owner id ${cfg.tgOwnerId}`);
  } else out("  (no TG_TOKEN: Telegram not checked)");

  const settings = new SettingsStore(dataDir).value;
  const lp = new LpService(chain, new PositionBook(dataDir), () => settings, true);
  const scanner = new Scanner(chain, () => settings, dataDir);
  const screener = cfg.typesafeKey ? new CachedScreener(new JevScreener({ apiKey: cfg.typesafeKey, model: cfg.jevModel })) : undefined;
  const auto = new Autopilot(lp, scanner, () => settings, async (t) => out(`  » ${t}`), dataDir, screener);

  // the autopilot waits for two samples to measure APR; here we only need pools to exist
  const found = await step("scan Swap logs for WETH pools", () => scanner.scan());
  out(`  ${scanner.indexedCount} pools indexed, ${found.length} with depth`);
  const deepest = [...found].sort((a, b) => (b.depthWei > a.depthWei ? 1 : -1));
  for (const c of deepest.slice(0, 5)) out(`  ${c.symbol.padEnd(12)} ${c.fee / 10_000}% · depth ${Number(ethers.formatEther(c.depthWei)).toFixed(2)} ETH`);
  if (!screener) out("  (no TYPESAFE_API_KEY: Jev screening skipped)");

  const size = ethers.parseEther(String(settings.autoSizeEth));
  let opened = false;
  for (const c of deepest.slice(0, TRY)) {
    const rt = await step(`round trip ${c.symbol}`, () => auto.roundTrip(c, size));
    if (!rt.ok) {
      out(`  skip: ${rt.reason}`);
      continue;
    }
    if (screener) {
      const sc = await step(`Jev ${c.symbol}`, () => auto.screen(c, settings));
      if (sc.assessment) out(`  copycat ${(sc.assessment.copycat * 100).toFixed(0)}% · rug signs ${(sc.assessment.rugSigns * 100).toFixed(0)}% · risk ${(sc.assessment.risk * 100).toFixed(0)}%`);
      if (!sc.ok) {
        out(`  skip: ${sc.reason}`);
        continue;
      }
    }
    const plan = await step(`plan ${c.symbol} (${settings.autoMode})`, () => lp.plan(c.pool, size, settings.autoMode));
    out(`  range ${plan.priceLower.toPrecision(4)} – ${plan.priceUpper.toPrecision(4)} ${c.symbol}/ETH`);
    const { rec } = await step("paper open", () => lp.open(plan));
    const st = await step(`value #${rec.id} from chain`, () => lp.status(rec));
    out(`  in range: ${st.inRange} · value ${ethers.formatEther(st.pnl.valueQuote)} ETH (PnL ${st.pnl.pnlPct.toFixed(2)}%)`);
    await step(`paper close #${rec.id}`, () => lp.close(rec.id, "smoke test"));
    opened = true;
    break;
  }
  if (!opened) out(`no pool in the top ${TRY} passed the round trip${screener ? " and Jev" : ""}: nothing opened`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  out("smoke test done");
}

main().catch(() => process.exit(1));
