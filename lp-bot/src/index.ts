import { loadConfig, SettingsStore } from "./config";
import { Chain } from "./chain/client";
import { PositionBook } from "./lp/positions";
import { LpService } from "./lp/service";
import { Telegram } from "./bot/telegram";
import { Handlers } from "./bot/handlers";
import { Monitor } from "./monitor";
import { Scanner } from "./auto/scanner";
import { Autopilot } from "./auto/autopilot";
import { CachedScreener } from "./auto/screen";
import { JevScreener } from "./auto/jev";
import { logger } from "./log";
import { BUY_URL, checkLicense, PRO_NAME } from "./license";

const log = logger("main");

async function main() {
  const cfg = loadConfig();
  const chain = new Chain(cfg);
  const net = await chain.provider.getNetwork();
  if (Number(net.chainId) !== cfg.chain.chainId) {
    throw new Error(`RPC is chain ${net.chainId}, expected ${cfg.chain.chainId} (${cfg.chain.name})`);
  }
  const lic = checkLicense(cfg.licenseKey);
  log.info(lic.pro ? `${PRO_NAME} · order ${lic.license.order}` : `free tier (${lic.reason}); Pro: ${BUY_URL}`);
  const settings = new SettingsStore(cfg.dataDir, lic.pro);
  const lp = new LpService(chain, new PositionBook(cfg.dataDir), () => settings.value, cfg.mode === "paper");
  const tg = new Telegram(cfg.tgToken, cfg.tgOwnerId);
  const scanner = new Scanner(chain, () => settings.value, cfg.dataDir);
  const screener = cfg.typesafeKey ? new CachedScreener(new JevScreener({ apiKey: cfg.typesafeKey, model: cfg.jevModel })) : undefined;
  const auto = new Autopilot(lp, scanner, () => settings.value, (t) => tg.send(t), cfg.dataDir, screener);
  const handlers = new Handlers(tg, lp, settings, auto);
  const monitor = new Monitor(lp, tg, handlers);

  log.info(`${cfg.mode.toUpperCase()} mode · ${cfg.chain.name} · wallet ${chain.address} · screener ${screener ? `jev (${cfg.jevModel})` : "none"}`);
  await tg.send(`🤖 LP Bot online · <b>${cfg.mode.toUpperCase()}</b> · ${cfg.chain.name} · ${lic.pro ? "Pro" : `free tier (Pro: ${BUY_URL})`}`).catch((e) => log.warn(`startup message failed: ${e.message}`));
  monitor.start();
  auto.start();

  const shutdown = () => {
    log.info("shutting down");
    monitor.stop();
    auto.stop();
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
