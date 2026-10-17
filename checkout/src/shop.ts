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
}

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
    const token = o.chain === "solana" ? `USDC (SPL) <code>${SOL_USDC}</code>` : `USDC on Base <code>${BASE_USDC}</code>`;
    return {
      chatId,
      text: [
        `🧾 Order <code>${o.id}</code> · ${esc(p.name)}`,
        "",
        `Send <b>exactly</b> <code>${fmtUsdc(o.amountMicro)}</code> USDC on <b>${CHAIN_NAME[o.chain]}</b>`,
        `to <code>${to}</code>`,
        token,
        "",
        `The exact amount is how we match your payment, so please don't round it. It's held for you for ${Math.round((o.expiresAt - o.createdAt) / 60_000)} min (a late exact payment still counts).`,
        `Payments are checked every ~${this.d.checkEveryMin} min; your license key arrives in this chat. /status to check.`,
      ].join("\n"),
      // no wallet deep-link button: Telegram buttons only take http(s)/tg links, not solana:/ethereum:
    };
  }

  /** The message a buyer gets once paid (also re-sent by /status). */
  delivery(o: Order): Reply | null {
    const chatId = chatOf(o);
    if (chatId === null || o.status !== "paid" || !o.license) return null;
    const p = this.product(o.product);
    return {
      chatId,
      text: [
        `✅ Payment received for <b>${esc(p?.name ?? o.product)}</b> (order <code>${o.id}</code>). Thank you!`,
        "",
        "Your license key: put it in the bot's <code>.env</code> as <code>LICENSE_KEY=</code> and restart.",
        `<code>${esc(o.license)}</code>`,
        "",
        esc(p?.deliver ?? ""),
        this.d.contact ? `Questions: ${esc(this.d.contact)}` : "",
      ]
        .filter((l, i, a) => l || a[i - 1])
        .join("\n"),
    };
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
    if (cmd === "/start" && arg?.startsWith("buy_")) {
      // buy_<product> or buy_<product>__<ref> (the store page passes its ?ref= through)
      const [productId, ref] = arg.slice(4).split("__");
      const p = this.product(productId ?? "");
      if (p) return { replies: [this.pickChain(chatId, p, cleanRef(ref))] };
    }
    return { replies: [this.menu(chatId)] };
  }
}
