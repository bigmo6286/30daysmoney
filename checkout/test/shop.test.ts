import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrderBook } from "../src/orders";
import { DEFAULT_PRODUCTS } from "../src/config";
import { chatOf, Shop, tgContact, type Update } from "../src/shop";
import { open, packDir, seal, stateKey, unpackDir } from "../src/statebox";
import { renderStore } from "../src/site";
import { generateKeys, issue, issueFor, payloadFor, readPayload, verify } from "../src/license";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "shop-"));
const SOL = "4Re3Gxt3bJNQmptr9YyFS3CTeHKoSS4S58NvyjhU4XsH";
const BASE = "0x51F0373A68B2Fa2aa61b41AeF13d5B74Aa1967A7";
const shop = (book = new OrderBook(tmp())) => ({ book, s: new Shop({ book, products: DEFAULT_PRODUCTS, receivers: { solana: SOL, base: BASE }, contact: "@seller", checkEveryMin: 5 }) });
let n = 0;
const msg = (text: string, chat = 42, type = "private"): Update => ({ update_id: ++n, message: { chat: { id: chat, type }, from: { id: chat, username: "buyer" }, text } });
const tap = (data: string, chat = 42): Update => ({ update_id: ++n, callback_query: { id: `q${n}`, from: { id: chat, username: "buyer" }, message: { chat: { id: chat } }, data } });

describe("telegram shop", () => {
  it("deep link from the store page → chain choice → an order with a unique exact amount", () => {
    const { s, book } = shop();
    const r1 = s.handle(msg("/start buy_lp-bot")).replies[0]!;
    expect(r1.text).toContain("LP Bot Pro");
    expect(r1.buttons![0]!.map((b) => b.data)).toEqual(["c:lp-bot:solana", "c:lp-bot:base"]);
    const out = s.handle(tap("c:lp-bot:base"));
    expect(out.answerCallback).toBeDefined();
    const o = book.all()[0]!;
    expect(o).toMatchObject({ product: "lp-bot", chain: "base", contact: "tg:42 @buyer", status: "pending" });
    expect(o.amountMicro).toBeGreaterThan(49_000_000);
    expect(out.replies[0]!.text).toContain((o.amountMicro / 1e6).toFixed(6));
    expect(out.replies[0]!.text).toContain(BASE);
    expect(out.replies[0]!.buttons).toBeUndefined(); // Telegram refuses non-http(s) button links
    // one destination only: the receiver is the "Send to", the token's own address is flagged as not one
    const text = out.replies[0]!.text;
    expect(text).toMatch(new RegExp(`Send to:</b> <code>${BASE}</code>`));
    expect(text.indexOf(BASE)).toBeLessThan(text.indexOf("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"));
    expect(text).toContain("don't send to it");
    expect(chatOf(o)).toBe(42);
  });

  it("carries the store link's ?ref= channel tag into the order; junk tags are dropped", () => {
    const { s, book } = shop();
    const r = s.handle(msg("/start buy_lp-bot__tg-robinhood")).replies[0]!;
    expect(r.buttons![0]![0]!.data).toBe("c:lp-bot:solana:tg-robinhood");
    expect(r.buttons![0]![0]!.data!.length).toBeLessThanOrEqual(64); // Telegram's callback limit
    s.handle(tap(r.buttons![0]![0]!.data!));
    expect(book.all()[0]!.ref).toBe("tg-robinhood");
    const junk = s.handle(msg("/start buy_lp-bot__<script>")).replies[0]!;
    expect(junk.buttons![0]![0]!.data).toBe("c:lp-bot:solana");
    s.handle(tap("c:lp-bot:base:Bad Ref!"));
    expect(book.all()[1]!.ref).toBeUndefined();
  });

  it("anything else shows the menu; group chats are ignored (keys are private)", () => {
    const { s } = shop();
    expect(s.handle(msg("hello")).replies[0]!.buttons!.length).toBe(DEFAULT_PRODUCTS.length);
    expect(s.handle(msg("/start buy_nope")).replies[0]!.text).toContain("Pick a product");
    expect(s.handle(msg("/start", -100, "group")).replies).toEqual([]);
    expect(s.handle(tap("c:lp-bot:dogecoin")).replies[0]!.text).toContain("Pick a product");
  });

  it("delivers the license to the buyer's chat once paid, and /status re-sends it", () => {
    const { s, book } = shop();
    s.handle(tap("c:dlmm-agent:solana", 7));
    const o = book.all()[0]!;
    expect(s.delivery(o)).toBeNull(); // not paid yet
    const paid = book.match({ chain: "solana", txid: "sig1", amountMicro: o.amountMicro, from: "x", at: Date.now() })!;
    const k = generateKeys();
    book.setLicense(paid.id, issue({ order: paid.id, product: paid.product, contact: paid.contact, issued: 1 }, k.privateKey));
    const d = s.delivery(book.get(paid.id)!)!;
    expect(d.chatId).toBe(7);
    expect(d.text).toContain(book.get(paid.id)!.license!);
    expect(d.text).toContain("LICENSE_KEY");
    const st = s.handle(msg("/status", 7)).replies;
    expect(st[0]!.text).toContain("paid");
    expect(st[1]!.text).toContain(book.get(paid.id)!.license!);
    expect(s.handle(msg("/status", 8)).replies[0]!.text).toContain("No orders"); // other people see nothing
  });

  it("contact format round-trips", () => {
    expect(tgContact(-5)).toBe("tg:-5");
    expect(chatOf({ contact: "tg:123 @x" } as never)).toBe(123);
    expect(chatOf({ contact: "@x" } as never)).toBeNull();
  });
});

describe("state box", () => {
  it("packs a data dir, unreadable without the key, tamper-evident", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "orders.json"), '{"orders":[{"contact":"tg:1"}]}');
    fs.writeFileSync(path.join(dir, "sales.csv"), "a,b\n");
    const key = stateKey("secret-license-key");
    const blob = seal(packDir(dir), key);
    expect(blob.toString("latin1")).not.toContain("tg:1");
    const back = tmp();
    unpackDir(open(blob, key), back);
    expect(fs.readFileSync(path.join(back, "orders.json"), "utf8")).toContain("tg:1");
    expect(() => open(blob, stateKey("other"))).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1]! ^= 1;
    expect(() => open(bad, key)).toThrow();
    expect(() => unpackDir({ "../x": "no" }, back)).toThrow(/bad file name/);
  });
});

describe("store page", () => {
  it("links every product to the shop bot and never ships delivery text", () => {
    const tpl = fs.readFileSync(new URL("../public/store.html", import.meta.url), "utf8");
    const html = renderStore(tpl, { products: DEFAULT_PRODUCTS, shopBot: "my_shop_bot", repoUrl: "https://github.com/x/y", checkEveryMin: 15 });
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain('const bot = "my_shop_bot"');
    expect(html).not.toContain(DEFAULT_PRODUCTS[0]!.deliver);
    expect(() => renderStore(tpl, { products: [], shopBot: "@bad name", repoUrl: "", checkEveryMin: 5 })).toThrow(/SHOP_BOT/);
    const evil = renderStore(tpl, { products: [{ id: "x", name: "</script><script>alert(1)</script>", priceUsd: 1, blurb: "" }], shopBot: "my_shop_bot", repoUrl: "", checkEveryMin: 5 });
    expect(evil).not.toContain("</script><script>alert(1)");
    const withSite = renderStore(tpl, { products: DEFAULT_PRODUCTS, shopBot: "my_shop_bot", repoUrl: "", checkEveryMin: 5, contact: "</script>@x", receivers: { base: BASE } });
    expect(withSite).toContain(BASE);
    expect(withSite).not.toContain("</script>@x");
    expect(withSite).toContain('"days":30');
  });
});

describe("paid guide", () => {
  it("encrypts so the published file reveals nothing, decrypts with the key, refuses a wrong or tampered one", async () => {
    const { newGuideKey, sealGuide, openGuide, renderGuide } = await import("../src/guide");
    const key = newGuideKey();
    const html = renderGuide("# Secret recipe\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    const s = sealGuide(html, key);
    expect(JSON.stringify(s)).not.toContain("Secret");
    expect(openGuide(s, key)).toBe(html);
    expect(html).toContain("<table>");
    expect(() => openGuide(s, newGuideKey())).toThrow();
    const bad = Buffer.from(s.ct, "base64");
    bad[3]! ^= 1;
    expect(() => openGuide({ ...s, ct: bad.toString("base64") }, key)).toThrow();
    expect(() => sealGuide("x", "short")).toThrow(/32 bytes/);
  });

  it("the buyer's delivery carries the reading link with the key in the #fragment; unsellable without a key", async () => {
    const { sellable } = await import("../src/shop");
    const book = new OrderBook(tmp());
    const s = new Shop({ book, products: DEFAULT_PRODUCTS, receivers: { solana: SOL }, contact: "@seller", checkEveryMin: 5, guide: { storeUrl: "https://x.github.io/repo", key: "KEY_abc-123" } });
    s.handle(tap("c:flash-guide:solana", 9));
    const o = book.all()[0]!;
    expect(o.amountMicro).toBeGreaterThan(19_000_000);
    book.match({ chain: "solana", txid: "sig", amountMicro: o.amountMicro, from: "x", at: Date.now() });
    book.setLicense(o.id, "LIC");
    const d = s.delivery(book.get(o.id)!)!;
    expect(d.text).toContain("https://x.github.io/repo/guide.html#g=flash-loans&amp;k=KEY_abc-123");
    expect(sellable(DEFAULT_PRODUCTS, false).map((p) => p.id)).not.toContain("flash-guide");
    expect(sellable(DEFAULT_PRODUCTS, true).map((p) => p.id)).toContain("flash-guide");
  });

  it("the committed guide is ciphertext only", () => {
    const committed = fs.readFileSync(new URL("../public/guides/flash-loans.json", import.meta.url), "utf8");
    const s = JSON.parse(committed);
    expect(s.v).toBe(1);
    for (const word of ["Morpho", "flash", "Uniswap", "<h1>"]) expect(committed).not.toContain(word);
  });
});

describe("subscriptions", () => {
  const DAY = 86_400_000;
  const now = 1_800_000_000_000;
  const o = { id: "o2", product: "pnl-pro", contact: "tg:42 @buyer" };

  it("a 30-day product expires 30 days after payment; lifetime and bots never do", () => {
    expect(payloadFor(o, 30, [], now)).toEqual({ order: "o2", product: "pnl-pro", contact: "tg:42 @buyer", issued: now, expires: now + 30 * DAY });
    expect(payloadFor({ ...o, product: "pnl-lifetime" }, undefined, [], now).expires).toBeUndefined();
  });

  it("renewing early adds on to the running key; an expired one or another product doesn't count", () => {
    const k = generateKeys();
    const running = issue({ order: "o1", product: "pnl-pro", contact: "tg:42", issued: now - 20 * DAY, expires: now + 10 * DAY }, k.privateKey);
    const lapsed = issue({ order: "o0", product: "pnl-pro", contact: "tg:42", issued: now - 90 * DAY, expires: now - 60 * DAY }, k.privateKey);
    const other = issue({ order: "o9", product: "lp-bot", contact: "tg:42", issued: now }, k.privateKey);
    expect(payloadFor(o, 30, [running, lapsed, other], now).expires).toBe(now + 40 * DAY);
    expect(payloadFor(o, 30, [lapsed, other], now).expires).toBe(now + 30 * DAY);
  });

  it("issueFor matches the buyer by Telegram chat (handles change), and signs a verifiable key", () => {
    const k = generateKeys();
    const paid = (id: string, contact: string, license?: string) => ({ id, product: "pnl-pro", chain: "base" as const, amountMicro: 1, contact, createdAt: 0, expiresAt: 0, status: "paid" as const, license });
    const first = issue({ order: "a", product: "pnl-pro", contact: "tg:42 @old", issued: now, expires: now + 5 * DAY }, k.privateKey);
    const stranger = issue({ order: "b", product: "pnl-pro", contact: "tg:7 @x", issued: now, expires: now + 25 * DAY }, k.privateKey);
    const me = paid("c", "tg:42 @new");
    const key = issueFor(me, DEFAULT_PRODUCTS, [paid("a", "tg:42 @old", first), paid("b", "tg:7 @x", stranger), me], k.privateKey, now);
    expect(verify(key, k.publicKey)).toMatchObject({ order: "c", product: "pnl-pro", expires: now + 35 * DAY });
  });

  it("the dashboard delivery says where to paste the key and until when; needs the store's address", async () => {
    const { sellable } = await import("../src/shop");
    const k = generateKeys();
    const book = new OrderBook(tmp());
    const s = new Shop({ book, products: DEFAULT_PRODUCTS, receivers: { base: BASE }, contact: "@seller", checkEveryMin: 5, storeUrl: "https://x.github.io/repo" });
    s.handle(tap("c:pnl-pro:base", 11));
    const ord = book.all()[0]!;
    expect(ord.amountMicro).toBeGreaterThan(15_000_000);
    book.match({ chain: "base", txid: "0xt", amountMicro: ord.amountMicro, from: "0xf", at: Date.now() });
    book.setLicense(ord.id, issueFor(book.get(ord.id)!, DEFAULT_PRODUCTS, book.all(), k.privateKey, Date.UTC(2026, 9, 17)));
    const text = s.delivery(book.get(ord.id)!)!.text;
    expect(text).toContain("https://x.github.io/repo/dashboard/");
    expect(text).toContain("Settings");
    expect(text).toContain("Valid until <b>2026-11-16</b>");
    expect(text).not.toContain("LICENSE_KEY");
    expect(readPayload(book.get(ord.id)!.license!)?.product).toBe("pnl-pro");
    expect(sellable(DEFAULT_PRODUCTS, true, false).map((p) => p.id)).not.toContain("pnl-pro");
    expect(sellable(DEFAULT_PRODUCTS, true, true).map((p) => p.id)).toEqual(expect.arrayContaining(["pnl-pro", "pnl-lifetime"]));
  });

  it("reminds once, 3 days before the buyer's latest key runs out, with a renew button", () => {
    const k = generateKeys();
    const book = new OrderBook(tmp());
    const s = new Shop({ book, products: DEFAULT_PRODUCTS, receivers: { base: BASE }, contact: "@seller", checkEveryMin: 5, storeUrl: "https://x.github.io/repo" });
    const buy = (at: number) => {
      s.handle(tap("c:pnl-pro:base", 11));
      const o = book.all().at(-1)!;
      book.match({ chain: "base", txid: `0x${o.id}`, amountMicro: o.amountMicro, from: "0xf", at: Date.now() });
      book.setLicense(o.id, issueFor(book.get(o.id)!, DEFAULT_PRODUCTS, book.all(), k.privateKey, at));
      return o;
    };
    const t0 = Date.now();
    buy(t0);
    expect(s.reminders(t0 + 20 * DAY)).toEqual([]);
    const r = s.reminders(t0 + 28 * DAY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ chatId: 11, buttons: [[{ data: "p:pnl-pro" }]] });
    expect(r[0]!.text).toContain("runs out in 2 days");
    expect(s.reminders(t0 + 29 * DAY)).toEqual([]); // once
    buy(t0 + 29 * DAY); // renewed: the new key runs to day 60
    expect(s.reminders(t0 + 50 * DAY)).toEqual([]);
    expect(s.reminders(t0 + 58 * DAY)).toHaveLength(1);
  });

  it("/stats: owner only; revenue against the goal, paid/started by product and by channel", () => {
    const book = new OrderBook(tmp());
    const s = new Shop({ book, products: DEFAULT_PRODUCTS, receivers: { base: BASE }, contact: "@seller", checkEveryMin: 5, ownerId: 1 });
    expect(s.handle(msg("/stats", 1)).replies[0]!.text).toContain("$0 of $2000");
    s.handle(tap("c:lp-bot:base:x", 20));
    s.handle(tap("c:pnl-pro:base:x", 21));
    s.handle(tap("c:pnl-pro:base", 22));
    const [a, b] = book.all();
    for (const o of [a!, b!]) book.match({ chain: "base", txid: `0x${o.id}`, amountMicro: o.amountMicro, from: "0xf", at: Date.now() });
    const text = s.handle(msg("/stats", 1)).replies[0]!.text;
    expect(text).toMatch(/\$64\.\d+ of \$2000<\/b> \(3%\) · 2 sales/);
    expect(text).toContain("LP Bot Pro: 1/1 paid");
    expect(text).toContain("LP PnL Dashboard Pro (30 days): 1/2 paid");
    expect(text).toMatch(/x: 2\/2 paid/);
    expect(text).toMatch(/direct: 0\/1 paid/);
    // anyone else just gets the shop menu
    expect(s.handle(msg("/stats", 99)).replies[0]!.text).not.toContain("of $2000");
  });
});
