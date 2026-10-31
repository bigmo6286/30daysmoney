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
import { MAX_WATCHES, type Watches } from "./watches";

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
  /** free trial: the product it unlocks, and a signer for its key (days → license); off when absent */
  trial?: { product: string; days: number; issue: (chatId: number, contact: string, days: number) => string };
  /** range alerts (Pro): the watch list; off when absent */
  watches?: Watches;
  /** affiliate program: commission % of each referred sale, and the shop bot's username for /invite links; off when absent */
  affiliate?: { pct: number; botName: string };
  /** flash-arb scan results per UTC day (written by flash-kit's scan), for the owner's /bot */
  arbStats?: () => ArbDay[];
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

/**
 * The bot's Telegram profile: the "/" command menu, the description shown before someone presses
 * Start, and the short one on its profile and in search. tick.ts sets it whenever it changes.
 */
export function botProfile(o: { trial: boolean; watches: boolean; affiliate?: number }) {
  const commands = [
    { command: "buy", description: "Products and prices" },
    { command: "status", description: "Your orders and license keys" },
    ...(o.trial ? [{ command: "trial", description: "Dashboard Pro free for 7 days" }] : []),
    ...(o.watches ? [{ command: "watch", description: "Alerts when an LP position leaves its range (Pro)" }] : []),
    ...(o.affiliate !== undefined ? [{ command: "invite", description: `Earn ${o.affiliate}% of every sale you bring` }] : []),
  ];
  const description = [
    "Checkout for 30daysmoney: LP tools for Uniswap v3/v4 (Robinhood Chain, Base, Arbitrum) and Meteora DLMM.",
    "",
    "• LP Bot Pro and DLMM Agent Pro: Telegram bots that run on your own machine with your keys",
    "• LP PnL Dashboard Pro: 20 wallets, history, CSV, range alerts" + (o.trial ? " (/trial: 7 days free)" : ""),
    "• Flash-loan arbitrage guide",
    "",
    "Pay in USDC on Base or Solana; your key arrives in this chat.",
  ].join("\n");
  const shortDescription = `LP bots + PnL dashboard for Uniswap v3/v4 and Meteora. Pay in USDC.${o.trial ? " Pro dashboard free for 7 days." : ""}`;
  return { commands, description, shortDescription };
}

/** Products whose delivery needs a guide key (or the store's address) can only be sold when it's configured. */
export const sellable = (products: Product[], guideConfigured: boolean, storeConfigured = true) =>
  products.filter((p) => (guideConfigured || !/\{\{GUIDE_URL:/.test(p.deliver)) && (storeConfigured || !/\{\{STORE_URL\}\}/.test(p.deliver)));

const KEY_LINE: Record<NonNullable<Product["keyFor"]>, string> = {
  bot: "Your license key: put it in the bot's <code>.env</code> as <code>LICENSE_KEY=</code> and restart. It also unlocks LP PnL Dashboard Pro.",
  dashboard: "Your license key (paste it in the dashboard's Settings):",
  none: "Your order key (keep it: it's your proof of purchase):",
};

/** keys that unlock Dashboard Pro (same list as pnl-dashboard/web/license.ts) */
const PRO_PRODUCTS = ["pnl-pro", "pnl-lifetime", "lp-bot", "lp-bot-setup", "dlmm-agent", "dlmm-agent-setup"];

const CHAIN_NAME: Record<Chain, string> = { solana: "Solana", base: "Base" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** one UTC day of flash-kit scan results (flash-kit/src/sol/scan.ts DayStats) */
export interface ArbDay {
  day: string;
  runs: number;
  quotes: number;
  candidates: number;
  sent: number;
  profit: number;
  paidOut: number;
  best?: { usd: number; sym: string };
  errors: number;
  lastAt: number;
  lastNote?: string;
  sol?: number;
}

/** The owner's /bot report: today in full, earlier days in one line each. */
export function arbReport(days: ArbDay[], now = Date.now()): string {
  if (!days.length) return "🤖 The flash-arb bot hasn't reported yet. It runs every 5 minutes once ARB_ENABLED is true.";
  const sorted = [...days].sort((a, b) => b.day.localeCompare(a.day));
  const d = sorted[0]!;
  const ago = Math.round((now - d.lastAt) / 60_000);
  const money = (n: number) => `$${n.toFixed(2)}`;
  const lines = [
    `🤖 <b>Flash-arb bot</b> · ${d.day}${d.day === new Date(now).toISOString().slice(0, 10) ? " (today)" : ""}`,
    `Last run: ${ago <= 1 ? "just now" : `${ago} min ago`}${ago > 20 ? " ⚠️ (runs every 5 min: check GitHub Actions)" : ""}`,
    `Runs ${d.runs} · price checks ${d.quotes} · looked profitable ${d.candidates} · trades ${d.sent}`,
    `Profit ${money(d.profit)} · paid out ${money(d.paidOut)}`,
    d.best ? `Closest call: ${d.best.usd >= 0 ? "+" : ""}${d.best.usd.toFixed(2)} USDC on ${d.best.sym}` : "",
    d.sol !== undefined ? `Bot wallet: ${d.sol.toFixed(4)} SOL${d.sol < 0.03 ? " ⚠️ top up soon (stops below 0.02)" : ""}` : "",
    d.errors ? `Problems today: ${d.errors}${d.lastNote ? `, latest: ${d.lastNote.replace(/&/g, "&amp;").replace(/</g, "&lt;")}` : ""}` : "",
  ];
  const earlier = sorted.slice(1, 7).map((x) => `${x.day}: ${x.runs} runs, ${x.sent} trades, ${money(x.profit)}`);
  const total = days.reduce((a, x) => a + x.profit, 0);
  return [...lines.filter(Boolean), ...(earlier.length ? ["", "<b>Earlier</b>", ...earlier] : []), "", `Total profit (7 days): ${money(total)}`].join("\n");
}

const usd2 = (n: number) => `$${n.toFixed(2)}`;
const usd = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;

/** contact stored on the order: the chat to deliver to, plus the @handle for the seller */
export const tgContact = (chatId: number, username?: string) => `tg:${chatId}${username ? ` @${username}` : ""}`;
/** refs are channel tags like "x" or "tg-robinhood": anything else is dropped */
export const cleanRef = (r?: string) => (r && /^[a-z0-9-]{1,16}$/.test(r) ? r : undefined);

export const chatOf = (o: Pick<Order, "contact">): number | null => {
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
      text: `<b>30daysmoney</b>\nLP bots, the PnL dashboard and guides. Pay in USDC; your key arrives here.${this.trialOn() ? "\n/trial: Dashboard Pro free for 7 days." : ""}${this.d.watches ? "\n/watch: Telegram alerts when an LP position leaves its range (Pro)." : ""}${this.d.affiliate ? `\n/invite: earn ${this.d.affiliate.pct}% of every sale you bring.` : ""}\nPick a product:`,
      buttons: this.d.products.map((p) => [{ text: `${p.name} · ${usd(p.priceUsd)}`, data: `p:${p.id}` }]),
    };
  }

  private pickChain(chatId: number, p: Product, ref?: string): Reply {
    return {
      chatId,
      text: `<b>${esc(p.name)}</b> · ${usd(p.priceUsd)} USDC, ${p.days ? `per ${p.days} days` : "one-time"}\n${esc(p.blurb)}\n\nPay with USDC on:`,
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
    const latest = new Map<string, { o: { id: string; product: string; contact: string; reminded?: number }; exp: number }>();
    const keys = [...this.d.book.all().filter((o) => o.status === "paid"), ...this.d.book.trials()];
    for (const o of keys) {
      const exp = o.license ? readPayload(o.license)?.expires : undefined;
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

  private trialOn() {
    const t = this.d.trial;
    return !!t && !!this.product(t.product);
  }

  /** One free trial key per Telegram chat; asking again re-sends the same key. */
  private trialCmd(chatId: number, username?: string): Reply {
    const t = this.d.trial!;
    const p = this.product(t.product)!;
    const contact = tgContact(chatId, username);
    const id = `trial:${chatId}`;
    let tr = this.d.book.trials().find((x) => x.id === id);
    const fresh = !tr;
    if (!tr) {
      tr = { id, product: p.id, contact, at: Date.now(), license: t.issue(chatId, contact, t.days) };
      this.d.book.addTrial(tr);
    }
    const exp = readPayload(tr.license)?.expires;
    const until = exp ? new Date(exp).toISOString().slice(0, 10) : "";
    const expired = exp !== undefined && exp < Date.now();
    return {
      chatId,
      text: [
        fresh ? `🎁 Your free <b>${esc(p.name.replace(/\s*\(.*\)$/, ""))}</b> trial (${t.days} days):` : `You've had your free trial (one per account). Here's that key again:`,
        `<code>${esc(tr.license)}</code>`,
        until ? `${expired ? "Ended" : "Valid until"} <b>${until}</b>.` : "",
        esc(this.deliverText(p.deliver).replace(/ Renew any time.*$/, "")),
        expired || !fresh ? `Keep Pro: ${usd(p.priceUsd)} per ${p.days ?? 30} days.` : "We'll remind you before it ends.",
      ]
        .filter(Boolean)
        .join("\n"),
      buttons: expired || !fresh ? [[{ text: `Get ${p.name} · ${usd(p.priceUsd)}`, data: `p:${p.id}` }]] : undefined,
    };
  }

  /** The chat's newest unexpired key that unlocks Dashboard Pro (paid, trial or any bot license), if any. */
  proUntil(chatId: number, now = Date.now()): number | null {
    let best: number | null = null;
    for (const o of [...this.d.book.all().filter((x) => x.status === "paid"), ...this.d.book.trials()]) {
      if (chatOf(o) !== chatId || !o.license || !PRO_PRODUCTS.includes(o.product)) continue;
      const exp = readPayload(o.license)?.expires ?? Infinity;
      if (exp > now && (best === null || exp > best)) best = exp;
    }
    return best;
  }

  private watchCmd(chatId: number, arg?: string, remove = false): Reply {
    const w = this.d.watches!;
    if (remove) {
      const n = w.remove(chatId, arg);
      return { chatId, text: n ? `Stopped watching ${arg && n === 1 ? `<code>${esc(arg.toLowerCase())}</code>` : `${n} wallet${n === 1 ? "" : "s"}`}.` : "Not watching that. /watch lists your wallets." };
    }
    if (this.proUntil(chatId) === null) {
      return {
        chatId,
        text: `🔔 Range alerts are a Dashboard Pro feature: I DM you when one of your LP positions goes out of range, and when it's back.${this.trialOn() ? " Try it free with /trial." : ""}`,
        buttons: this.product("pnl-pro") ? [[{ text: "Get Dashboard Pro", data: "p:pnl-pro" }]] : undefined,
      };
    }
    if (!arg) {
      const mine = w.of(chatId);
      return {
        chatId,
        text: mine.length
          ? ["🔔 Watching:", ...mine.map((x) => `<code>${x.address}</code>`), "", "/unwatch &lt;address&gt; to stop."].join("\n")
          : `🔔 Send <code>/watch 0x…</code> with a wallet address (up to ${MAX_WATCHES}). I check its Uniswap v3/v4 positions on Robinhood Chain, Base and Arbitrum about every 15 minutes and DM you when one leaves or re-enters its range.`,
      };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) return { chatId, text: "That isn't an EVM address (0x + 40 hex). Solana wallets aren't supported for alerts yet." };
    const r = w.add(chatId, arg);
    const text =
      r === "added"
        ? `✅ Watching <code>${arg.toLowerCase()}</code>. The first check records the current ranges; after that you'll hear about changes.`
        : r === "exists"
          ? "Already watching that wallet."
          : `You're watching ${MAX_WATCHES} wallets, the most. /unwatch one first.`;
    return { chatId, text };
  }

  /** Watches whose chat no longer has Pro (a lapsed subscription or trial): removed, with one message each. */
  pruneWatches(now = Date.now()): Reply[] {
    const w = this.d.watches;
    if (!w) return [];
    const out: Reply[] = [];
    for (const chatId of new Set(w.all().map((x) => x.chatId))) {
      if (this.proUntil(chatId, now) !== null) continue;
      w.remove(chatId);
      out.push({ chatId, text: "🔕 Range alerts stopped: your Dashboard Pro key has run out. Renew, then send /watch again to turn them back on.", buttons: this.product("pnl-pro") ? [[{ text: "Renew Dashboard Pro", data: "p:pnl-pro" }]] : undefined });
    }
    return out;
  }

  private affCode = (chatId: number) => `u-${chatId.toString(36)}`;

  /** The affiliate's link and terms, and what they've earned so far. */
  private inviteCmd(chatId: number): Reply {
    const a = this.d.affiliate!;
    const code = this.affCode(chatId);
    const mine = this.d.book.commissions().filter((c) => c.referrer === chatId);
    const earned = mine.reduce((s, c) => s + c.usd, 0);
    const paid = mine.filter((c) => c.paidAt).reduce((s, c) => s + c.usd, 0);
    const payout = this.d.book.payoutOf(chatId);
    const store = this.d.storeUrl ?? this.d.guide?.storeUrl;
    return {
      chatId,
      text: [
        `🤝 <b>Earn ${a.pct}% of every sale you bring.</b> Share either link; anyone who buys through it (bots, dashboard, guide) earns you ${a.pct}% of what they pay, in USDC.`,
        `Shop bot: https://t.me/${a.botName}?start=${code}`,
        store ? `Store page: ${store.replace(/\/?$/, "/")}?ref=${code}` : "",
        "",
        `Earned so far: ${usd2(earned)} (${usd2(earned - paid)} not yet sent).`,
        payout ? `Payouts go to <code>${esc(payout)}</code> (change with /payout).` : "Tell us where to pay: <code>/payout &lt;your Base or Solana USDC address&gt;</code>",
      ]
        .filter((l, i, arr) => l || arr[i - 1])
        .join("\n"),
    };
  }

  private payoutCmd(chatId: number, addr?: string): Reply {
    if (!addr || !(/^0x[0-9a-fA-F]{40}$/.test(addr) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))) {
      return { chatId, text: "Send <code>/payout 0x…</code> (USDC on Base) or a Solana address (USDC on Solana)." };
    }
    this.d.book.setPayout(chatId, addr);
    return { chatId, text: `✅ Commissions will be sent to <code>${esc(addr)}</code>.` };
  }

  /**
   * After a referred order is paid: record the affiliate's commission and tell them. Self-referrals
   * earn nothing. Returns the message for the affiliate and a line for the seller's sale alert.
   */
  commission(o: Order, now = Date.now()): { replies: Reply[]; ownerNote?: string } {
    const a = this.d.affiliate;
    const m = /^u-([0-9a-z]{1,13})$/.exec(o.ref ?? "");
    if (!a || !m || o.status !== "paid") return { replies: [] };
    const referrer = parseInt(m[1]!, 36);
    if (!Number.isSafeInteger(referrer) || referrer === chatOf(o)) return { replies: [] };
    const amount = Math.round(o.amountMicro * a.pct) / 1e8; // micro-USDC × pct% → USD
    const value = Math.round(amount * 100) / 100;
    if (this.d.book.commissions().some((c) => c.order === o.id)) return { replies: [] };
    this.d.book.addCommission({ order: o.id, referrer, usd: value, at: now });
    const payout = this.d.book.payoutOf(referrer);
    const name = this.product(o.product)?.name ?? o.product;
    return {
      replies: [
        {
          chatId: referrer,
          text: `💰 You earned <b>${usd2(value)}</b>: someone bought ${esc(name)} through your link. ${payout ? `It'll be sent to <code>${esc(payout)}</code>.` : "Send <code>/payout &lt;address&gt;</code> so we know where to pay you."}`,
        },
      ],
      ownerNote: `🤝 affiliate ${o.ref}: owe ${usd2(value)}${payout ? ` → ${payout}` : " (no payout address yet)"}`,
    };
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
      ...this.owedLines(),
      ...(all.length ? ["<b>By product</b> (paid/started)", ...table((o) => this.product(o.product)?.name ?? o.product), "", "<b>By channel</b> (store link ?ref=)", ...table((o) => o.ref ?? "direct")] : []),
    ]
      .filter((l, i, a) => l || a[i - 1])
      .join("\n");
  }

  private owedLines(): string[] {
    const owed = new Map<number, number>();
    for (const c of this.d.book.commissions()) if (!c.paidAt) owed.set(c.referrer, (owed.get(c.referrer) ?? 0) + c.usd);
    if (!owed.size) return [];
    return [
      "<b>Affiliates to pay</b> (then /paidout &lt;code&gt;)",
      ...[...owed.entries()].map(([r, v]) => `${this.affCode(r)}: ${usd2(v)} → ${this.d.book.payoutOf(r) ? `<code>${esc(this.d.book.payoutOf(r)!)}</code>` : "no address yet"}`),
      "",
    ];
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
          const o = this.d.book.create(p.id, p.priceUsd, chain, tgContact(chatId, q.from.username), cleanRef(rawRef) ?? this.d.book.referrerOf(chatId));
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
    if ((cmd === "/trial" || (cmd === "/start" && arg === "trial")) && this.trialOn()) return { replies: [this.trialCmd(chatId, m.from?.username)] };
    if ((cmd === "/watch" || cmd === "/unwatch") && this.d.watches) return { replies: [this.watchCmd(chatId, arg, cmd === "/unwatch")] };
    if (this.d.affiliate) {
      if (cmd === "/invite") return { replies: [this.inviteCmd(chatId)] };
      if (cmd === "/payout") return { replies: [this.payoutCmd(chatId, arg)] };
      if (cmd === "/start" && arg && /^u-[0-9a-z]{1,13}$/.test(arg)) {
        if (arg !== this.affCode(chatId)) this.d.book.setReferrer(chatId, arg);
        return { replies: [this.menu(chatId)] };
      }
      if (cmd === "/paidout" && this.d.ownerId !== undefined && chatId === this.d.ownerId && arg && /^u-[0-9a-z]{1,13}$/.test(arg)) {
        const total = this.d.book.markPaid(parseInt(arg.slice(2), 36), Date.now());
        return { replies: [{ chatId, text: total ? `✅ Marked ${usd2(total)} to ${arg} as paid.` : `Nothing owed to ${arg}.` }] };
      }
    }
    if (cmd === "/bot" && this.d.arbStats && this.d.ownerId !== undefined && chatId === this.d.ownerId) return { replies: [{ chatId, text: arbReport(this.d.arbStats()) }] };
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
