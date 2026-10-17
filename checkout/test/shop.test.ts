import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OrderBook } from "../src/orders";
import { DEFAULT_PRODUCTS } from "../src/config";
import { chatOf, Shop, tgContact, type Update } from "../src/shop";
import { open, packDir, seal, stateKey, unpackDir } from "../src/statebox";
import { renderStore } from "../src/site";
import { generateKeys, issue } from "../src/license";

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
