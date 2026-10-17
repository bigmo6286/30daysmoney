import path from "node:path";
import fs from "node:fs";
import { loadConfig, loadProducts } from "./config";
import { fmtUsdc, OrderBook, type Order, type Transfer } from "./orders";
import { issue } from "./license";
import { createServer, loadHtml } from "./server";
import { SolanaWatcher } from "./watch/solana";
import { BaseWatcher } from "./watch/base";
import { readJson, writeJsonAtomic } from "./store";
import { logger } from "./log";

const log = logger("checkout");

async function main() {
  const cfg = loadConfig();
  const products = loadProducts(cfg.dataDir);
  const book = new OrderBook(cfg.dataDir, cfg.orderTtlMin * 60_000);
  const stateFile = path.join(cfg.dataDir, "watchers.json");
  const st = readJson<{ solana?: { cursor?: string }; base?: { next?: number } }>(stateFile, {});
  const sol = cfg.solReceiver ? new SolanaWatcher(cfg.solRpc, cfg.solReceiver, st.solana ?? {}) : null;
  const base = cfg.baseReceiver ? new BaseWatcher(cfg.baseRpc, cfg.baseReceiver, st.base ?? {}) : null;

  const notify = async (text: string) => {
    if (!cfg.tgToken || !cfg.tgOwnerId) return;
    await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.tgOwnerId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => log.warn(`telegram: ${e instanceof Error ? e.message : e}`));
  };

  const onPaid = async (o: Order) => {
    const license = issue({ order: o.id, product: o.product, contact: o.contact, issued: Date.now() }, cfg.licenseKey);
    book.setLicense(o.id, license);
    fs.appendFileSync(path.join(cfg.dataDir, "sales.csv"), `${new Date(o.paid!.at).toISOString()},${o.id},${o.product},${o.chain},${fmtUsdc(o.amountMicro)},${o.paid!.txid},${JSON.stringify(o.contact)},${o.ref ?? ""}\n`);
    log.info(`PAID ${o.id} ${o.product} ${fmtUsdc(o.amountMicro)} USDC on ${o.chain}`);
    await notify(`💸 Sale: ${o.product} · ${fmtUsdc(o.amountMicro)} USDC on ${o.chain}${o.paid!.late ? " (paid after expiry)" : ""}\norder ${o.id} · contact ${o.contact}\ntx ${o.paid!.txid}`);
  };

  const poll = async () => {
    for (const [name, w] of [["solana", sol], ["base", base]] as const) {
      if (!w) continue;
      let transfers: Transfer[] = [];
      try {
        transfers = await w.poll();
      } catch (e) {
        log.warn(`${name} poll failed: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      for (const t of transfers) {
        const o = book.match(t);
        if (o) await onPaid(o);
        else log.info(`unmatched ${t.chain} transfer ${fmtUsdc(t.amountMicro)} USDC from ${t.from} (${t.txid})`);
      }
    }
    book.expire();
    writeJsonAtomic(stateFile, { solana: sol?.state, base: base?.state });
  };

  const html = loadHtml(new URL("../public/index.html", import.meta.url));
  const receivers = { ...(cfg.solReceiver ? { solana: cfg.solReceiver } : {}), ...(cfg.baseReceiver ? { base: cfg.baseReceiver } : {}) };
  const server = createServer({ book, products, receivers, contact: cfg.contact, html, trustProxy: cfg.trustProxy });
  server.listen(cfg.port, () => log.info(`listening on :${cfg.port} · receiving on ${Object.keys(receivers).join(" + ")} · ${products.length} products`));

  let timer: NodeJS.Timeout;
  const loop = async () => {
    await poll().catch((e) => log.warn(`poll: ${e}`));
    timer = setTimeout(loop, cfg.pollSec * 1000);
  };
  void loop();
  const shutdown = () => {
    clearTimeout(timer);
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
