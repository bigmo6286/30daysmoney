/**
 * `npm run smoke`: one full pass against mainnet without Telegram and without signing.
 * Discovery → screening → gates (mint facts, Jupiter round trip, Jev if keyed) on the top pools,
 * then a paper open of the first that passes, valued from the chain and closed again.
 * Used after install (and by the setup service) to prove RPC, Meteora and Jupiter all answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, SettingsStore } from "./config";
import { Solana } from "./chain/solana";
import { Jupiter } from "./chain/jupiter";
import { PaperExecutor, SdkPools } from "./chain/dlmm";
import { TokenGates } from "./auto/gates";
import { CachedScreener, JevScreener } from "./auto/jev";
import { discover } from "./auto/discovery";
import { Agent } from "./auto/agent";
import { PositionBook } from "./positions";

const TRY = 8;

async function main() {
  // paper only, on a throwaway data dir: the real book and settings are never touched
  const cfg = loadConfig({ ...process.env, MODE: "paper" });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-smoke-"));
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

  const sol = new Solana(cfg.rpcUrl, null, cfg.paperAddress || "11111111111111111111111111111111");
  await step(`RPC ${new URL(cfg.rpcUrl).host}`, () => sol.connection.getLatestBlockhash());
  const settings = new SettingsStore(dataDir).value;
  const pools = new SdkPools(sol);
  const screener = cfg.typesafeKey ? new CachedScreener(new JevScreener(cfg.typesafeKey, cfg.jevModel)) : undefined;
  const agent = new Agent({
    exec: new PaperExecutor(pools),
    pools,
    gates: new TokenGates(sol.connection, new Jupiter(cfg.jupiterKey), screener),
    discover: (q) => discover(q),
    book: new PositionBook(dataDir),
    settings: () => settings,
    notify: async (t) => out(`  » ${t.replace(/\n/g, "\n    ")}`),
    balanceSol: null,
    dataDir,
  });

  const ranked = await step("Meteora discovery + screening", () => agent.scan(settings));
  out(`  ${agent.seen.size} pools found, ${ranked.length} pass screening, ${agent.rejected.length} rejected`);
  for (const r of ranked.slice(0, 5)) out(`  ${r.pool.symbol.padEnd(12)} fee/TVL ${r.pool.feeTvlPct.toFixed(2)}% · TVL $${Math.round(r.pool.tvlUsd).toLocaleString("en-US")}`);
  if (!screener) out("  (no TYPESAFE_API_KEY: Jev screening skipped)");

  let opened = false;
  for (const c of ranked.slice(0, TRY)) {
    const g = await step(`gates ${c.pool.symbol}`, () => agent.check(c.pool, settings, { skipScreen: !screener }));
    if (!g.ok) {
      out(`  skip: ${g.reason}${g.error ? " (could not decide)" : ""}`);
      continue;
    }
    const rec = await step(`paper open ${c.pool.symbol}`, () => agent.open(c.pool, settings.sizeSol, settings, false, g));
    const st = await step(`value #${rec.id} from chain`, () => agent.status(rec, settings));
    out(`  active bin ${st.activeId} · range ${st.range} · value ${st.valueSol.toFixed(4)} SOL`);
    await step(`paper close #${rec.id}`, () => agent.close(rec.id, "smoke test"));
    opened = true;
    break;
  }
  if (!opened) out(`no pool passed every gate in the top ${TRY}: nothing opened (this happens; the gates are strict)`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  out("smoke test done");
}

main().catch(() => process.exit(1));
