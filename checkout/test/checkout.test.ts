import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { OrderBook, fmtUsdc } from "../src/orders";
import { generateKeys, issue, publicKeyOf, verify } from "../src/license";
import { incoming, SolanaWatcher, usdcAccount, SOL_USDC } from "../src/watch/solana";
import { BaseWatcher, parseLog, BASE_USDC } from "../src/watch/base";
import { createServer } from "../src/server";
import { DEFAULT_PRODUCTS, loadConfig } from "../src/config";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));
const OWNER = "4Re3Gxt3bJNQmptr9YyFS3CTeHKoSS4S58NvyjhU4XsH";
const OWNER_USDC = "ByMHTQ858hJ4wE1nK9WQ9zgseNWqtjPrwcQd1c2o5HZ9"; // from @solana/spl-token getAssociatedTokenAddressSync

describe("orders", () => {
  it("gives every order a unique amount just above the price", () => {
    const b = new OrderBook(tmp());
    const amounts = new Set<number>();
    for (let i = 0; i < 300; i++) {
      const o = b.create("lp-bot", 49, "solana", "@a");
      expect(o.amountMicro).toBeGreaterThan(49_000_000);
      expect(o.amountMicro).toBeLessThan(49_010_000);
      amounts.add(o.amountMicro);
    }
    expect(amounts.size).toBe(300);
    expect(fmtUsdc(49_000_137)).toBe("49.000137");
  });

  it("matches the exact amount on the right chain, once; late payments still count", () => {
    let now = 1_000_000;
    const b = new OrderBook(tmp(), 60_000, () => now);
    const o = b.create("lp-bot", 49, "base", "@a");
    const tr = { chain: "base" as const, txid: "0xabc:1", amountMicro: o.amountMicro, from: "0xme", at: now + 5_000 };
    expect(b.match({ ...tr, chain: "solana" })).toBeNull();
    expect(b.match({ ...tr, amountMicro: o.amountMicro + 1 })).toBeNull();
    expect(b.match({ ...tr, at: now - 10 * 60_000 })).toBeNull(); // long before the order existed
    expect(b.match(tr)?.id).toBe(o.id);
    expect(b.get(o.id)).toMatchObject({ status: "paid", paid: { late: false } });
    expect(b.match(tr)).toBeNull(); // same tx again

    const o2 = b.create("lp-bot", 49, "base", "@b");
    now += 120_000;
    expect(b.expire().map((x) => x.id)).toEqual([o2.id]);
    expect(b.match({ ...tr, txid: "0xdef:0", amountMicro: o2.amountMicro, at: now })).toMatchObject({ id: o2.id, paid: { late: true } });
  });

  it("persists across restarts", () => {
    const dir = tmp();
    const o = new OrderBook(dir).create("lp-bot", 49, "solana", "@a");
    expect(new OrderBook(dir).get(o.id)?.amountMicro).toBe(o.amountMicro);
  });
});

describe("license", () => {
  it("verifies its own keys and rejects tampering", () => {
    const k = generateKeys();
    expect(publicKeyOf(k.privateKey)).toBe(k.publicKey);
    const lic = issue({ order: "o1", product: "lp-bot", contact: "@a", issued: 1 }, k.privateKey);
    expect(verify(lic, k.publicKey)).toEqual({ order: "o1", product: "lp-bot", contact: "@a", issued: 1 });
    const [body, sig] = lic.split(".");
    const forged = Buffer.from(JSON.stringify({ order: "o1", product: "dlmm-agent-setup", contact: "@a", issued: 1 })).toString("base64url");
    expect(verify(`${forged}.${sig}`, k.publicKey)).toBeNull();
    expect(verify(lic, generateKeys().publicKey)).toBeNull();
    expect(verify(`${body}`, k.publicKey)).toBeNull();
  });
});

const solTx = (amount: string, pre = "1000000", err: unknown = null) => ({
  blockTime: 1_700_000_000,
  meta: {
    err,
    preTokenBalances: [
      { accountIndex: 1, mint: SOL_USDC, owner: "Buyer", uiTokenAmount: { amount: "100000000" } },
      { accountIndex: 2, mint: SOL_USDC, owner: OWNER, uiTokenAmount: { amount: pre } },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: SOL_USDC, owner: "Buyer", uiTokenAmount: { amount: String(100_000_000 - Number(amount)) } },
      { accountIndex: 2, mint: SOL_USDC, owner: OWNER, uiTokenAmount: { amount: String(Number(pre) + Number(amount)) } },
    ],
  },
  transaction: { message: { accountKeys: [{ pubkey: "Buyer" }, { pubkey: "BuyerUsdc" }, { pubkey: OWNER_USDC }] } },
});

describe("solana watcher", () => {
  it("derives the owner's USDC account like the SPL library", () => {
    expect(usdcAccount(OWNER)).toBe(OWNER_USDC);
  });
  it("reads the received amount and the sender from token balance deltas", () => {
    expect(incoming(solTx("49000137"), OWNER_USDC)).toEqual({ amountMicro: 49_000_137, from: "Buyer" });
    // a first transfer into a fresh account has no pre balance entry
    const fresh = solTx("5", "0");
    fresh.meta.preTokenBalances = fresh.meta.preTokenBalances.slice(0, 1);
    expect(incoming(fresh, OWNER_USDC)?.amountMicro).toBe(5);
    expect(incoming(solTx("49000137", "1000000", { InstructionError: [0, "x"] }), OWNER_USDC)).toBeNull();
    expect(incoming(solTx("0"), OWNER_USDC)).toBeNull();
    expect(incoming(solTx("10"), "SomeoneElse")).toBeNull();
  });
  it("polls new signatures oldest first and keeps a cursor", async () => {
    const calls: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      calls.push(b);
      const result =
        b.method === "getSignaturesForAddress"
          ? [{ signature: "S2", err: null, blockTime: 2 }, { signature: "S1", err: null, blockTime: 1 }, { signature: "S0", err: { x: 1 }, blockTime: 0 }]
          : solTx(b.params[0] === "S1" ? "1" : "2");
      return new Response(JSON.stringify({ result }));
    }) as unknown as typeof fetch;
    const w = new SolanaWatcher("http://rpc", OWNER, {}, f);
    const got = await w.poll();
    expect(got.map((t) => [t.txid, t.amountMicro])).toEqual([["S1", 1], ["S2", 2]]);
    expect(w.state.cursor).toBe("S2");
    expect(calls.filter((c) => c.method === "getTransaction")).toHaveLength(2); // failed tx skipped
    expect(calls[0].params[0]).toBe(OWNER_USDC);
  });
});

describe("solana watcher failures", () => {
  it("asks for v1 transactions, and a failed read keeps the cursor before it (retried, never skipped)", async () => {
    let fail = true;
    const seen: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      seen.push(b);
      if (b.method === "getSignaturesForAddress") return new Response(JSON.stringify({ result: [{ signature: "S3", err: null }, { signature: "S2", err: null }, { signature: "S1", err: null }] }));
      if (b.params[0] === "S2" && fail) return new Response(JSON.stringify({ error: { code: -32000, message: "node hiccup" } }));
      return new Response(JSON.stringify({ result: solTx("7") }));
    }) as unknown as typeof fetch;
    const w = new SolanaWatcher("http://rpc", OWNER, { cursor: "S0" }, f);
    const first = await w.poll();
    expect(first.map((t) => t.txid)).toEqual(["S1"]);
    expect(w.state.cursor).toBe("S1"); // S2 failed: not passed
    expect(seen.find((b) => b.method === "getTransaction").params[1].maxSupportedTransactionVersion).toBe(1);
    fail = false;
    const second = await w.poll();
    // this mock ignores `until`, so S1 comes back too; the order book drops repeated txids
    expect(second.map((t) => t.txid)).toEqual(["S1", "S2", "S3"]);
    expect(w.state.cursor).toBe("S3");
  });
  it("treats in-body rate-limit errors as retryable", async () => {
    let n = 0;
    const f = (async () => (++n < 3 ? new Response(JSON.stringify({ error: { code: -32011, message: "request limit reached" } })) : new Response(JSON.stringify({ result: "0x10" })))) as unknown as typeof fetch;
    const { rpc } = await import("../src/watch/rpc");
    expect(await rpc<string>("http://x", "eth_blockNumber", [], f, 3, 1)).toBe("0x10");
    expect(n).toBe(3);
  });
});

describe("base watcher", () => {
  const RECV = "0x1111111111111111111111111111111111111111";
  const log = (amount: number, over: Record<string, unknown> = {}) => ({
    address: BASE_USDC,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "0x" + "0".repeat(24) + "2222222222222222222222222222222222222222", "0x" + "0".repeat(24) + RECV.slice(2)],
    data: "0x" + amount.toString(16).padStart(64, "0"),
    blockNumber: "0x64",
    transactionHash: "0xfeed",
    logIndex: "0x3",
    ...over,
  });
  it("parses USDC Transfer logs and ignores other tokens and removed logs", () => {
    expect(parseLog(log(99_000_042))).toEqual({ txid: "0xfeed:3", amountMicro: 99_000_042, from: "0x2222222222222222222222222222222222222222", block: 100 });
    expect(parseLog(log(1, { address: "0xdead" }))).toBeNull();
    expect(parseLog(log(1, { removed: true }))).toBeNull();
  });
  it("scans from the cursor to head − confirmations with block timestamps", async () => {
    const calls: any[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      calls.push(b);
      const result = b.method === "eth_blockNumber" ? "0x6b" : b.method === "eth_getLogs" ? [log(49_000_001)] : { timestamp: "0x65000000" };
      return new Response(JSON.stringify({ result }));
    }) as unknown as typeof fetch;
    const w = new BaseWatcher("http://rpc", RECV, { next: 100 }, f);
    const got = await w.poll();
    expect(got).toEqual([{ chain: "base", txid: "0xfeed:3", amountMicro: 49_000_001, from: "0x2222222222222222222222222222222222222222", at: 0x65000000 * 1000 }]);
    const q = calls.find((c) => c.method === "eth_getLogs").params[0];
    expect([q.fromBlock, q.toBlock]).toEqual(["0x64", "0x68"]); // 0x6b − 3
    expect(q.topics[2]).toBe("0x" + "0".repeat(24) + RECV.slice(2));
    expect(w.state.next).toBe(0x69);
  });

  it("shrinks the log range down to Alchemy's free-tier 10 blocks in one poll, skipping nothing", async () => {
    const ranges: [number, number][] = [];
    const f = (async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (b.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x" + (1000 + 3).toString(16) }));
      const [q] = b.params;
      const [from, to] = [parseInt(q.fromBlock, 16), parseInt(q.toBlock, 16)];
      if (to - from + 1 > 10) return new Response(JSON.stringify({ error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range." } }), { status: 400 });
      ranges.push([from, to]);
      return new Response(JSON.stringify({ result: [] }));
    }) as unknown as typeof fetch;
    const w = new BaseWatcher("http://rpc", RECV, { next: 951 }, f);
    expect(await w.poll()).toEqual([]);
    expect(ranges[0]).toEqual([951, 960]);
    expect(ranges.at(-1)![1]).toBe(1000);
    ranges.forEach((r, i) => i && expect(r[0]).toBe(ranges[i - 1]![1] + 1)); // contiguous
    expect(w.state.next).toBe(1001);
  });
});

describe("http api", () => {
  async function serve() {
    const book = new OrderBook(tmp());
    const srv = createServer({ book, products: DEFAULT_PRODUCTS, receivers: { solana: OWNER }, contact: "@seller", html: "<h1>hi</h1>", trustProxy: false, rateLimit: 3 });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { book, srv, base };
  }
  const post = (base: string, body: unknown) => fetch(`${base}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("serves the page, products without delivery text, creates and reports orders", async () => {
    const { book, srv, base } = await serve();
    try {
      expect(await (await fetch(base)).text()).toContain("hi");
      const prods = await (await fetch(`${base}/api/products`)).json();
      expect(prods.chains).toEqual(["solana"]);
      expect(prods.products[0].deliver).toBeUndefined();

      const r = await post(base, { product: "lp-bot", chain: "solana", contact: "@buyer" });
      expect(r.status).toBe(201);
      const o = await r.json();
      expect(o.amount).toMatch(/^49\.00\d{4}$/);
      expect(o.receiver).toBe(OWNER);
      expect(o.payUrl).toContain(`solana:${OWNER}?amount=${o.amount}&spl-token=${SOL_USDC}`);
      expect(o.license).toBeUndefined();
      expect(o.deliver).toBeUndefined();

      book.match({ chain: "solana", txid: "sig", amountMicro: book.get(o.id)!.amountMicro, from: "b", at: Date.now() });
      book.setLicense(o.id, "LIC");
      const paid = await (await fetch(`${base}/api/orders/${o.id}`)).json();
      expect(paid).toMatchObject({ status: "paid", license: "LIC", contact: "@seller" });
      expect(paid.deliver).toContain("github.com/bigmo6286/30daysmoney");

      expect((await post(base, { product: "lp-bot", chain: "base", contact: "@x" })).status).toBe(400); // base not enabled
      expect((await post(base, { product: "nope", chain: "solana", contact: "@x" })).status).toBe(404);
      expect((await post(base, { product: "lp-bot", chain: "solana" })).status).toBe(400);
      expect((await fetch(`${base}/api/orders`, { method: "POST", body: "{not json" })).status).toBe(400);
      expect((await post(base, { product: "lp-bot", chain: "solana", contact: "@y" })).status).toBe(201);
      expect((await post(base, { product: "lp-bot", chain: "solana", contact: "@z" })).status).toBe(201);
      expect((await post(base, { product: "lp-bot", chain: "solana", contact: "@w" })).status).toBe(429); // 3 per hour
      expect((await fetch(`${base}/api/orders/doesnotexist`)).status).toBe(404);
    } finally {
      srv.close();
    }
  });
});

describe("config", () => {
  it("requires a receiver and a license key, and rejects token accounts as receivers", () => {
    const k = generateKeys().privateKey;
    expect(() => loadConfig({ LICENSE_PRIVATE_KEY: k })).toThrow(/SOL_RECEIVER/);
    expect(() => loadConfig({ SOL_RECEIVER: OWNER })).toThrow(/keygen/);
    expect(() => loadConfig({ BASE_RECEIVER: "0x12", LICENSE_PRIVATE_KEY: k })).toThrow(/0x address/);
    expect(loadConfig({ SOL_RECEIVER: OWNER, LICENSE_PRIVATE_KEY: k }).solReceiver).toBe(OWNER);
  });
});
