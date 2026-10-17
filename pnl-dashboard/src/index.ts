import fs from "node:fs";
import { loadConfig } from "./config";
import { collect } from "./collect";
import { cached, createServer } from "./server";
import { logger } from "./log";

const log = logger("pnl");

function main() {
  const cfg = loadConfig();
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const summary = cached(() => collect(cfg), cfg.refreshSec * 1000);
  const srv = createServer({ html, password: cfg.password, summary });
  srv.listen(cfg.port, cfg.host, () =>
    log.info(`http://${cfg.host}:${cfg.port} · ${cfg.wallets.length} wallets · lp-bot ${cfg.lpBot ? "on" : "off"} · dlmm-agent ${cfg.dlmmDataDir ? "on" : "off"}${cfg.password ? " · password on" : ""}`),
  );
  const shutdown = () => srv.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (e) {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
