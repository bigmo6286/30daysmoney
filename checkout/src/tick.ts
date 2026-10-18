/**
 * `npm run tick`: one pass of the serverless shop, run every few minutes by a scheduled GitHub
 * Action (.github/workflows/shop.yml). Answers the Telegram messages that arrived since the last
 * pass, reads new USDC transfers, and on a match issues the license key and DMs it to the buyer.
 * Then exits; all state lives in DATA_DIR (the workflow carries it between runs, encrypted).
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadProducts } from "./config";
import { fmtUsdc, OrderBook, type Order, type Transfer } from "./orders";
import { issueFor } from "./license";
import { SolanaWatcher } from "./watch/solana";
import { BaseWatcher } from "./watch/base";
import { readJson, writeJsonAtomic } from "./store";
import { sellable, Shop, type Button, type Reply, type Update } from "./shop";
import { logger } from "./log";

const log = logger("tick");

export class TelegramApi {
  constructor(
    private readonly token: string,
    /** overridable for tests against a fake Telegram */
    private readonly base = process.env.TG_API_URL || "https://api.telegram.org",
  ) {}
  async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const r = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
    return j.result;
  }
  send(r: Reply) {
    const kb = r.buttons?.map((row) => row.map((b: Button) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })));
    return this.call("sendMessage", { chat_id: r.chatId, text: r.text, parse_mode: "HTML", disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) });
  }
}

async function main() {
  const e = process.env;
  const cfg = loadConfig(e);
  const shopToken = (e.SHOP_TG_TOKEN || "").trim();
  if (!shopToken) throw new Error("SHOP_TG_TOKEN is required: a Telegram bot just for the shop (not the one your lp-bot uses)");
  const tg = new TelegramApi(shopToken);
  const checkEveryMin = Number(e.CHECK_EVERY_MIN || 5);
  const guideKey = (e.GUIDE_KEY || "").trim();
  const storeUrl = (e.STORE_URL || "").trim();
  const guide = guideKey && storeUrl ? { storeUrl, key: guideKey } : undefined;
  const products = sellable(loadProducts(cfg.dataDir), !!guide, !!storeUrl);
  const book = new OrderBook(cfg.dataDir, cfg.orderTtlMin * 60_000);
  const receivers = { ...(cfg.solReceiver ? { solana: cfg.solReceiver } : {}), ...(cfg.baseReceiver ? { base: cfg.baseReceiver } : {}) };
  const shop = new Shop({ book, products, receivers, contact: cfg.contact, checkEveryMin, guide, storeUrl: storeUrl || undefined, ownerId: /^-?\d+$/.test(cfg.tgOwnerId) ? Number(cfg.tgOwnerId) : undefined });
  const stateFile = path.join(cfg.dataDir, "watchers.json");
  const st = readJson<{ solana?: { cursor?: string }; base?: { next?: number }; tgOffset?: number }>(stateFile, {});
  const save = (extra: object) => writeJsonAtomic(stateFile, { ...readJson(stateFile, {}), ...extra });
  const owner = (text: string) => (cfg.tgOwnerId ? tg.send({ chatId: Number(cfg.tgOwnerId), text }).catch((err) => log.warn(`owner ping: ${err.message}`)) : undefined);

  // 1. Telegram: everything since the last pass (Telegram keeps updates for 24 h)
  const updates = await tg.call<Update[]>("getUpdates", { offset: st.tgOffset ?? 0, timeout: 0, allowed_updates: ["message", "callback_query"] });
  for (const u of updates) {
    try {
      const { replies, answerCallback } = shop.handle(u);
      if (answerCallback) await tg.call("answerCallbackQuery", { callback_query_id: answerCallback }).catch(() => undefined); // stale after a few minutes; harmless
      for (const r of replies) await tg.send(r);
    } catch (err) {
      log.warn(`update ${u.update_id}: ${err instanceof Error ? err.message : err}`);
    }
    save({ tgOffset: u.update_id + 1 }); // per update: a crash never answers anything twice
  }
  if (updates.length) log.info(`${updates.length} telegram updates`);

  // 2. payments
  const onPaid = async (o: Order) => {
    book.setLicense(o.id, issueFor(o, products, book.all(), cfg.licenseKey));
    const paid = book.get(o.id)!;
    fs.appendFileSync(path.join(cfg.dataDir, "sales.csv"), `${new Date(paid.paid!.at).toISOString()},${paid.id},${paid.product},${paid.chain},${fmtUsdc(paid.amountMicro)},${paid.paid!.txid},${JSON.stringify(paid.contact)},${paid.ref ?? ""}\n`);
    log.info(`PAID ${paid.id} ${paid.product} ${fmtUsdc(paid.amountMicro)} USDC on ${paid.chain}`);
    const d = shop.delivery(paid);
    if (d) await tg.send(d).catch((err) => log.warn(`deliver ${paid.id}: ${err.message}`));
    await owner(`💸 Sale: ${paid.product} · ${fmtUsdc(paid.amountMicro)} USDC on ${paid.chain}${paid.paid!.late ? " (paid after expiry)" : ""}\norder ${paid.id} · ${paid.contact}${paid.ref ? ` · via ${paid.ref}` : ""}\ntx ${paid.paid!.txid}`);
  };
  const watchers = [
    ["solana", cfg.solReceiver ? new SolanaWatcher(cfg.solRpc, cfg.solReceiver, st.solana ?? {}) : null],
    ["base", cfg.baseReceiver ? new BaseWatcher(cfg.baseRpc, cfg.baseReceiver, st.base ?? {}) : null],
  ] as const;
  for (const [name, w] of watchers) {
    if (!w) continue;
    let transfers: Transfer[] = [];
    try {
      transfers = await w.poll();
    } catch (err) {
      log.warn(`${name} poll failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    for (const t of transfers) {
      const o = book.match(t);
      if (o) await onPaid(o);
      else {
        log.info(`unmatched ${t.chain} transfer ${fmtUsdc(t.amountMicro)} USDC (${t.txid})`);
        await owner(`❓ Unmatched ${fmtUsdc(t.amountMicro)} USDC on ${t.chain} from ${t.from}\ntx ${t.txid}`);
      }
    }
    save({ [name]: w.state });
  }
  book.expire();

  // 3. subscriptions running out
  for (const r of shop.reminders()) await tg.send(r).catch((err) => log.warn(`reminder: ${err.message}`));
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
