import { loadConfig, SettingsStore } from "./config";
import { Solana, loadKeypair } from "./chain/solana";
import { Jupiter } from "./chain/jupiter";
import { LiveExecutor, PaperExecutor, SdkPools } from "./chain/dlmm";
import { TokenGates } from "./auto/gates";
import { CachedScreener, JevScreener } from "./auto/jev";
import { discover } from "./auto/discovery";
import { Agent } from "./auto/agent";
import { PositionBook } from "./positions";
import { Telegram } from "./bot/telegram";
import { Handlers } from "./bot/handlers";
import { logger } from "./log";

const log = logger("main");

async function main() {
  const cfg = loadConfig();
  const payer = cfg.walletKey ? loadKeypair(cfg.walletKey) : null;
  // paper mode never signs, even when a key is present
  const sol = new Solana(cfg.rpcUrl, cfg.mode === "live" ? payer : null, cfg.paperAddress || payer?.publicKey.toBase58());
  await sol.connection.getLatestBlockhash().catch((e) => {
    // host only: RPC URLs often carry an API key in the path or query
    throw new Error(`RPC ${new URL(cfg.rpcUrl).host} unreachable: ${e instanceof Error ? e.message : e}`);
  });
  const settings = new SettingsStore(cfg.dataDir);
  const jup = new Jupiter(cfg.jupiterKey);
  const pools = new SdkPools(sol);
  const exec = cfg.mode === "live" ? new LiveExecutor(sol, pools, jup) : new PaperExecutor(pools);
  const screener = cfg.typesafeKey ? new CachedScreener(new JevScreener(cfg.typesafeKey, cfg.jevModel)) : undefined;
  const tg = new Telegram(cfg.tgToken, cfg.tgOwnerId);
  const book = new PositionBook(cfg.dataDir);
  const agent = new Agent({
    exec,
    pools,
    gates: new TokenGates(sol.connection, jup, screener),
    discover: (q) => discover(q),
    book,
    settings: () => settings.value,
    notify: (t) => tg.send(t),
    balanceSol: cfg.mode === "live" ? () => sol.balanceSol() : null,
    dataDir: cfg.dataDir,
  });
  const handlers = new Handlers(tg, agent, book, settings, { address: sol.address.toBase58(), balanceSol: () => sol.balanceSol() });

  log.info(`${cfg.mode.toUpperCase()} mode · wallet ${sol.address.toBase58()} · screener ${screener ? `jev (${cfg.jevModel})` : "none"}`);
  await tg.send(`🤖 DLMM Agent online · <b>${cfg.mode.toUpperCase()}</b>`).catch((e) => log.warn(`startup message failed: ${e.message}`));
  agent.start();

  const shutdown = () => {
    log.info("shutting down");
    agent.stop();
    tg.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await tg.start((m) => handlers.handle(m));
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
