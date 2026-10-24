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
import { issue, issueFor, payloadFor } from "./license";
import { SolanaWatcher } from "./watch/solana";
import { BaseWatcher } from "./watch/base";
import { readJson, writeJsonAtomic } from "./store";
import { Watches } from "./watches";
import { botProfile, sellable, Shop, type Button, type Reply, type Update } from "./shop";
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
  const shopBot = (e.SHOP_BOT || "").replace(/^@/, "").trim();
  const refPct = (v?: string) => {
    const n = Number(v || 20);
    if (!(n >= 0 && n <= 50)) throw new Error("REF_PCT must be a number from 0 to 50 (the affiliate commission, %)");
    return n;
  };
  const guideKey = (e.GUIDE_KEY || "").trim();
  const storeUrl = (e.STORE_URL || "").trim();
  const guide = guideKey && storeUrl ? { storeUrl, key: guideKey } : undefined;
  const products = sellable(loadProducts(cfg.dataDir), !!guide, !!storeUrl);
  const book = new OrderBook(cfg.dataDir, cfg.orderTtlMin * 60_000);
  const receivers = { ...(cfg.solReceiver ? { solana: cfg.solReceiver } : {}), ...(cfg.baseReceiver ? { base: cfg.baseReceiver } : {}) };
  const shop = new Shop({ book, products, receivers, contact: cfg.contact, checkEveryMin, guide, storeUrl: storeUrl || undefined,
    watches: new Watches(cfg.dataDir),
    // affiliates earn REF_PCT% (default 20) of sales through their /invite link; needs the shop bot's username
    affiliate: shopBot ? { pct: refPct(e.REF_PCT), botName: shopBot } : undefined,
    // buying during the trial adds on to it (issueFor counts trial keys as the buyer's earlier keys)
    trial: { product: "pnl-pro", days: 7, issue: (chatId: number, contact: string, days: number) => issue(payloadFor({ id: `trial-${chatId}`, product: "pnl-pro", contact }, days), cfg.licenseKey) }, ownerId: /^-?\d+$/.test(cfg.tgOwnerId) ? Number(cfg.tgOwnerId) : undefined });
  const stateFile = path.join(cfg.dataDir, "watchers.json");
  const st = readJson<{ solana?: { cursor?: string }; base?: { next?: number }; tgOffset?: number; profile?: string }>(stateFile, {});
  const save = (extra: object) => writeJsonAtomic(stateFile, { ...readJson(stateFile, {}), ...extra });
  const owner = (text: string) => (cfg.tgOwnerId ? tg.send({ chatId: Number(cfg.tgOwnerId), text }).catch((err) => log.warn(`owner ping: ${err.message}`)) : undefined);

  // 1. Telegram: everything since the last pass (Telegram keeps updates for 24 h)
  // 0. the bot's command menu and descriptions, whenever they change
  const profile = botProfile({ trial: true, watches: true, affiliate: shopBot ? refPct(e.REF_PCT) : undefined });
  const profileKey = JSON.stringify(profile);
  if (st.profile !== profileKey) {
    try {
      await tg.call("setMyCommands", { commands: profile.commands });
      await tg.call("setMyDescription", { description: profile.description });
      await tg.call("setMyShortDescription", { short_description: profile.shortDescription });
      save({ profile: profileKey });
      log.info("bot profile updated");
    } catch (err) {
      log.warn(`bot profile: ${err instanceof Error ? err.message : err}`); // retried next tick
    }
  }

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
    book.setLicense(o.id, issueFor(o, products, [...book.all(), ...book.trials()], cfg.licenseKey));
    const paid = book.get(o.id)!;
    fs.appendFileSync(path.join(cfg.dataDir, "sales.csv"), `${new Date(paid.paid!.at).toISOString()},${paid.id},${paid.product},${paid.chain},${fmtUsdc(paid.amountMicro)},${paid.paid!.txid},${JSON.stringify(paid.contact)},${paid.ref ?? ""}\n`);
    log.info(`PAID ${paid.id} ${paid.product} ${fmtUsdc(paid.amountMicro)} USDC on ${paid.chain}`);
    const d = shop.delivery(paid);
    if (d) await tg.send(d).catch((err) => log.warn(`deliver ${paid.id}: ${err.message}`));
    const aff = shop.commission(paid);
    for (const r of aff.replies) await tg.send(r).catch((err) => log.warn(`affiliate ${paid.id}: ${err.message}`));
    await owner(`💸 Sale: ${paid.product} · ${fmtUsdc(paid.amountMicro)} USDC on ${paid.chain}${paid.paid!.late ? " (paid after expiry)" : ""}\norder ${paid.id} · ${paid.contact}${paid.ref ? ` · via ${paid.ref}` : ""}\ntx ${paid.paid!.txid}${aff.ownerNote ? `\n${aff.ownerNote}` : ""}`);
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
  // 4. range alerts only for chats that still have Pro (pnl-dashboard's alerts script reads the list next)
  for (const r of shop.pruneWatches()) await tg.send(r).catch((err) => log.warn(`watch prune: ${err.message}`));
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
