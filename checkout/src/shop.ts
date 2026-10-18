/**
 * Checkout over Telegram, for running without a server: the store page (GitHub Pages) links to
 * t.me/<shop bot>?start=buy_<product>; the bot makes the unique-amount order, and when the
 * watcher sees the payment the license key arrives in the same chat. Nothing here holds keys or
 * funds. Pure logic: `handle` turns one Telegram update into replies, the caller sends them.
 */
import type { Product } from "./config";
import { fmtUsdc, type Chain, type Order, type OrderBook } from "./orders";
import { BASE_USDC } from "./watch/base";
import { SOL_USDC } from "./watch/solana";
import { guideUrl } from "./guide";
import { readPayload } from "./license";

export interface Button {
  text: string;
  data?: string;
  url?: string;
}

export interface Reply {
  chatId: number;
  text: string;
  buttons?: Button[][];
}

export interface Update {
  update_id: number;
  message?: { chat: { id: number; type?: string }; from?: { id: number; username?: string }; text?: string };
  callback_query?: { id: string; from: { id: number; username?: string }; message?: { chat: { id: number } }; data?: string };
}

export interface ShopDeps {
  book: OrderBook;
  products: Product[];
  receivers: Partial<Record<Chain, string>>;
  /** seller contact shown with deliveries */
  contact: string;
  /** how often payments are checked, for the "your key arrives within…" line */
  checkEveryMin: number;
  /** the seller's Telegram id: only this chat gets /stats */
  ownerId?: number;
  /** revenue target shown in /stats */
  goalUsd?: number;
  /** where the store lives (GitHub Pages), for {{STORE_URL}} in delivery text, e.g. the dashboard */
  storeUrl?: string;
  /** paid guides: where the store lives and the key that opens them (GUIDE_KEY) */
  guide?: { storeUrl: string; key: string };
}

const GUIDE_TAG = /\{\{GUIDE_URL:([a-z0-9-]{1,40})\}\}/g;
const STORE_TAG = /\{\{STORE_URL\}\}/g;

/** Products whose delivery needs a guide key (or the store's address) can only be sold when it's configured. */
export const sellable = (products: Product[], guideConfigured: boolean, storeConfigured = true) =>
  products.filter((p) => (guideConfigured || !/\{\{GUIDE_URL:/.test(p.deliver)) && (storeConfigured || !/\{\{STORE_URL\}\}/.test(p.deliver)));

const KEY_LINE: Record<NonNullable<Product["keyFor"]>, string> = {
  bot: "Your license key: put it in the bot's <code>.env</code> as <code>LICENSE_KEY=</code> and restart. It also unlocks LP PnL Dashboard Pro.",
  dashboard: "Your license key (paste it in the dashboard's Settings):",
  none: "Your order key (keep it: it's your proof of purchase):",
};

const CHAIN_NAME: Record<Chain, string> = { solana: "Solana", base: "Base" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

/** contact stored on the order: the chat to deliver to, plus the @handle for the seller */
export const tgContact = (chatId: number, username?: string) => `tg:${chatId}${username ? ` @${username}` : ""}`;
/** refs are channel tags like "x" or "tg-robinhood": anything else is dropped */
export const cleanRef = (r?: string) => (r && /^[a-z0-9-]{1,16}$/.test(r) ? r : undefined);

export const chatOf = (o: Order): number | null => {
  const m = /^tg:(-?\d+)/.exec(o.contact);
  return m ? Number(m[1]) : null;
};

export class Shop {
  constructor(private readonly d: ShopDeps) {}

  private product(id: string) {
    return this.d.products.find((p) => p.id === id);
  }

  private chains(): Chain[] {
    return (Object.keys(this.d.receivers) as Chain[]).filter((c) => this.d.receivers[c]);
  }

  private menu(chatId: number): Reply {
    return {
      chatId,
      text: "<b>30daysmoney bots</b>\nSelf-hosted liquidity bots. Pay once in USDC, your license key arrives here.\nPick a product:",
      buttons: this.d.products.map((p) => [{ text: `${p.name} · ${usd(p.priceUsd)}`, data: `p:${p.id}` }]),
    };
  }

  private pickChain(chatId: number, p: Product, ref?: string): Reply {
    return {
      chatId,
      text: `<b>${esc(p.name)}</b> · ${usd(p.priceUsd)} USDC, one-time\n${esc(p.blurb)}\n\nPay with USDC on:`,
      buttons: [this.chains().map((c) => ({ text: CHAIN_NAME[c], data: `c:${p.id}:${c}${ref ? `:${ref}` : ""}` }))],
    };
  }

  private payment(chatId: number, o: Order, p: Product): Reply {
    const to = this.d.receivers[o.chain]!;
    const chain = CHAIN_NAME[o.chain];
    const tokenId = o.chain === "solana" ? `USDC mint <code>${SOL_USDC}</code>` : `USDC contract <code>${BASE_USDC}</code>`;
    return {
      chatId,
      text: [
        `🧾 Order <code>${o.id}</code> · ${esc(p.name)}`,
        "",
        `<b>Amount:</b> <code>${fmtUsdc(o.amountMicro)}</code> USDC (exactly; don't round it)`,
        `<b>Network:</b> ${chain}`,
        `<b>Send to:</b> <code>${to}</code>`,
        "",
        `Only send USDC on ${chain}. To check your wallet picked real USDC, it's the token with ${tokenId}. That's the token's own address: <b>don't send to it</b>.`,
        "",
        `The exact amount is how we match your payment. This order holds it for ${Math.round((o.expiresAt - o.createdAt) / 60_000)} min (a late exact payment still counts). Started an order on the other network too? Just ignore that one; only the chain you pay on matters.`,
        `Payments are checked every ~${this.d.checkEveryMin} min; your license key arrives in this chat. /status to check.`,
      ].join("\n"),
      // no wallet deep-link button: Telegram buttons only take http(s)/tg links, not solana:/ethereum:
    };
  }

  private deliverText(t: string): string {
    const g = this.d.guide;
    const store = this.d.storeUrl ?? g?.storeUrl;
    return t
      .replace(GUIDE_TAG, (_m, name: string) => (g ? guideUrl(g.storeUrl, name, g.key) : "(the seller will send your link)"))
      .replace(STORE_TAG, store ? store.replace(/\/?$/, "/") : "");
  }

  /** The message a buyer gets once paid (also re-sent by /status). */
  delivery(o: Order): Reply | null {
    const chatId = chatOf(o);
    if (chatId === null || o.status !== "paid" || !o.license) return null;
    const p = this.product(o.product);
    const exp = readPayload(o.license)?.expires;
    const until = exp ? new Date(exp).toISOString().slice(0, 10) : "";
    return {
      chatId,
      text: [
        `✅ Payment received for <b>${esc(p?.name ?? o.product)}</b> (order <code>${o.id}</code>). Thank you!`,
        "",
        KEY_LINE[p?.keyFor ?? "bot"],
        `<code>${esc(o.license)}</code>`,
        until ? `Valid until <b>${until}</b>.` : "",
        "",
        esc(this.deliverText(p?.deliver ?? "")),
        this.d.contact ? `Questions: ${esc(this.d.contact)}` : "",
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join("\n"),
    };
  }

  /**
   * "Your subscription ends in N days" for each buyer whose latest key for a subscription runs
   * out within `withinDays` (once per key). The button starts a renewal, which adds on.
   */
  reminders(now = Date.now(), withinDays = 3): Reply[] {
    const out: Reply[] = [];
    const latest = new Map<string, { o: Order; exp: number }>();
    for (const o of this.d.book.all()) {
      const exp = o.status === "paid" && o.license ? readPayload(o.license)?.expires : undefined;
      const chatId = chatOf(o);
      if (!exp || chatId === null) continue;
      const k = `${chatId}|${o.product}`;
      if (!latest.has(k) || latest.get(k)!.exp < exp) latest.set(k, { o, exp });
    }
    for (const { o, exp } of latest.values()) {
      if (o.reminded || exp < now || exp - now > withinDays * 86_400_000) continue;
      const p = this.product(o.product);
      if (!p) continue;
      const days = Math.max(1, Math.ceil((exp - now) / 86_400_000));
      this.d.book.setReminded(o.id, now);
      out.push({
        chatId: chatOf(o)!,
        text: `⏳ Your <b>${esc(p.name)}</b> key runs out in ${days} day${days > 1 ? "s" : ""} (${new Date(exp).toISOString().slice(0, 10)}). Renew now and the new key adds ${p.days ?? 30} days on top: nothing is lost by renewing early.`,
        buttons: [[{ text: `Renew · ${usd(p.priceUsd)}`, data: `p:${p.id}` }]],
      });
    }
    return out;
  }

  private status(chatId: number): Reply[] {
    const mine = this.d.book.all().filter((o) => chatOf(o) === chatId).slice(-5);
    if (!mine.length) return [{ chatId, text: "No orders yet. /buy to start one." }];
    const out: Reply[] = [];
    const lines = mine.map((o) => `<code>${o.id}</code> · ${esc(this.product(o.product)?.name ?? o.product)} · ${fmtUsdc(o.amountMicro)} USDC on ${CHAIN_NAME[o.chain]} · <b>${o.status}</b>`);
    out.push({ chatId, text: ["Your orders:", ...lines].join("\n") });
    for (const o of mine) {
      const d = this.delivery(o);
      if (d) out.push(d);
    }
    return out;
  }

  /** Seller's view: revenue against the goal, and orders started → paid by product and by store-link channel. */
  stats(now = Date.now()): string {
    const all = this.d.book.all();
    const paid = all.filter((o) => o.status === "paid");
    const usdOf = (os: typeof all) => os.reduce((a, o) => a + o.amountMicro, 0) / 1e6;
    const week = paid.filter((o) => (o.paid?.at ?? 0) > now - 7 * 86_400_000);
    const goal = this.d.goalUsd ?? 2000;
    const table = (key: (o: (typeof all)[number]) => string) => {
      const rows = new Map<string, { started: number; paid: number; usd: number }>();
      for (const o of all) {
        const r = rows.get(key(o)) ?? { started: 0, paid: 0, usd: 0 };
        r.started++;
        if (o.status === "paid") {
          r.paid++;
          r.usd += o.amountMicro / 1e6;
        }
        rows.set(key(o), r);
      }
      return [...rows.entries()]
        .sort((a, b) => b[1].usd - a[1].usd || b[1].started - a[1].started)
        .map(([k, r]) => `${esc(k)}: ${r.paid}/${r.started} paid · ${usd(Math.round(r.usd * 100) / 100)}`);
    };
    const total = usdOf(paid);
    return [
      `📊 <b>${usd(Math.round(total * 100) / 100)} of ${usd(goal)}</b> (${Math.floor((total / goal) * 100)}%) · ${paid.length} sale${paid.length === 1 ? "" : "s"}`,
      `Last 7 days: ${usd(Math.round(usdOf(week) * 100) / 100)} from ${week.length}`,
      all.length ? "" : "No orders yet.",
      ...(all.length ? ["<b>By product</b> (paid/started)", ...table((o) => this.product(o.product)?.name ?? o.product), "", "<b>By channel</b> (store link ?ref=)", ...table((o) => o.ref ?? "direct")] : []),
    ]
      .filter((l, i, a) => l || a[i - 1])
      .join("\n");
  }

  handle(u: Update): { replies: Reply[]; answerCallback?: string } {
    if (u.callback_query) {
      const q = u.callback_query;
      const chatId = q.message?.chat.id ?? q.from.id;
      const [kind, productId, chain, rawRef] = (q.data ?? "").split(":");
      const p = productId ? this.product(productId) : undefined;
      if (kind === "p" && p) return { replies: [this.pickChain(chatId, p)], answerCallback: q.id };
      if (kind === "c" && p && (chain === "solana" || chain === "base") && this.d.receivers[chain]) {
        try {
          const o = this.d.book.create(p.id, p.priceUsd, chain, tgContact(chatId, q.from.username), cleanRef(rawRef));
          return { replies: [this.payment(chatId, o, p)], answerCallback: q.id };
        } catch (e) {
          return { replies: [{ chatId, text: `⚠️ ${esc(e instanceof Error ? e.message : String(e))}` }], answerCallback: q.id };
        }
      }
      return { replies: [this.menu(chatId)], answerCallback: q.id };
    }
    const m = u.message;
    if (!m?.text || m.chat.type && m.chat.type !== "private") return { replies: [] }; // DMs only: keys are private
    const chatId = m.chat.id;
    const [cmd, arg] = m.text.trim().split(/\s+/);
    if (cmd === "/status") return { replies: this.status(chatId) };
    if (cmd === "/stats" && this.d.ownerId !== undefined && chatId === this.d.ownerId) return { replies: [{ chatId, text: this.stats() }] };
    if (cmd === "/start" && arg?.startsWith("buy_")) {
      // buy_<product> or buy_<product>__<ref> (the store page passes its ?ref= through)
      const [productId, ref] = arg.slice(4).split("__");
      const p = this.product(productId ?? "");
      if (p) return { replies: [this.pickChain(chatId, p, cleanRef(ref))] };
    }
    return { replies: [this.menu(chatId)] };
  }
}
