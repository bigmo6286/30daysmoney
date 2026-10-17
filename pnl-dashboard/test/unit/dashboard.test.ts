import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { summarize, toCsv, type Row } from "../../src/model";
import { dlmmRows, lpBotRows } from "../../src/sources/books";
import { valueInWeth, v3Rows, type V3Chain, type V3Position } from "../../src/sources/univ3";
import { binPrice, dlmmValue, dlmmWalletRows } from "../../src/sources/dlmm";
import { collect, mergeRows } from "../../src/collect";
import { loadConfig, parseWallets, type DashConfig } from "../../src/config";
import { cached, createServer } from "../../src/server";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pnl-"));
const e18 = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const DAY = 86_400_000;

function lpBook(dir: string) {
  fs.writeFileSync(
    path.join(dir, "positions.json"),
    JSON.stringify({
      open: { "77": { id: "77", kind: "live", symbol: "FROG", fee: 3000, depositQuote: e18(1).toString(), openedAt: 1, inRange: true }, P1: { id: "P1", kind: "paper", symbol: "TOAD", fee: 10000, depositQuote: e18(0.5).toString(), openedAt: 2 } },
      closed: [
        { id: "70", kind: "live", symbol: "FROG", fee: 3000, openedAt: 0, closedAt: Date.UTC(2026, 9, 10, 12), depositQuote: e18(1).toString(), realizedQuote: e18(1.2).toString(), feesQuote: e18(0.05).toString(), pnlQuote: e18(0.2).toString(), pnlPct: 20, reason: "take profit" },
        { id: "71", kind: "live", symbol: "RUG", fee: 10000, openedAt: 0, closedAt: Date.UTC(2026, 9, 10, 18), depositQuote: e18(1).toString(), realizedQuote: e18(0.7).toString(), feesQuote: "0", pnlQuote: (-e18(0.3)).toString(), pnlPct: -30, reason: "stop loss" },
      ],
    }),
  );
}
function dlmmBook(dir: string) {
  fs.writeFileSync(
    path.join(dir, "positions.json"),
    JSON.stringify({
      open: [{ id: "3", position: "PosLive111", symbol: "BONK", depositSol: 0.5, openedAt: 5 }],
      closed: [{ id: "1", position: "paper-x", symbol: "WIF", openedAt: 0, closedAt: Date.UTC(2026, 9, 11), spentSol: 0.1, receivedSol: 0.12, pnlSol: 0.02, pnlPct: 20, reason: "trailing TP" }],
    }),
  );
}

describe("bot books", () => {
  it("reads lp-bot open + closed with wei → ETH", () => {
    const d = tmp();
    lpBook(d);
    const rows = lpBotRows(d, "Base");
    expect(rows.find((r) => r.id === "77")).toMatchObject({ status: "open", depositNative: 1, pair: "FROG/ETH 0.3%", paper: false, chain: "Base" });
    expect(rows.find((r) => r.id === "P1")).toMatchObject({ paper: true, note: expect.stringContaining("paper") });
    expect(rows.find((r) => r.id === "71")).toMatchObject({ status: "closed", pnlNative: -0.3, valueNative: 0.7, note: "stop loss" });
  });
  it("reads dlmm-agent rows, keyed by position account (live) or #id (paper)", () => {
    const d = tmp();
    dlmmBook(d);
    const rows = dlmmRows(d);
    expect(rows[0]).toMatchObject({ id: "PosLive111", unit: "SOL", status: "open", depositNative: 0.5, paper: false });
    expect(rows[1]).toMatchObject({ id: "#1", paper: true, pnlNative: 0.02, valueNative: 0.12, depositNative: 0.1 });
  });
  it("missing books are just empty", () => {
    expect(lpBotRows(tmp(), "x")).toEqual([]);
    expect(dlmmRows(tmp())).toEqual([]);
  });
});

describe("summary", () => {
  it("totals per unit, unrealized only where the cost basis is known, daily realized", () => {
    const d1 = tmp();
    const d2 = tmp();
    lpBook(d1);
    dlmmBook(d2);
    const rows = [...lpBotRows(d1, "Base"), ...dlmmRows(d2)];
    rows.find((r) => r.id === "77")!.valueNative = 1.1;
    rows.push({ source: "wallet", chain: "Base", id: "9", pair: "X/ETH", status: "open", unit: "ETH", valueNative: 2, feesNative: 0.01 });
    const s = summarize(rows);
    expect(s.totals.ETH.openValue).toBeCloseTo(3.1);
    expect(s.totals.ETH.unrealized).toBeCloseTo(0.1); // the wallet position has no deposit → not counted
    expect(s.totals.ETH.realized).toBeCloseTo(-0.1);
    expect(s.totals.ETH).toMatchObject({ closed: 2, wins: 1 });
    expect(s.totals.SOL.realized).toBeCloseTo(0.02);
    expect(s.daily).toEqual([
      { day: "2026-10-10", unit: "ETH", pnl: expect.closeTo(-0.1), count: 2 },
      { day: "2026-10-11", unit: "SOL", pnl: expect.closeTo(0.02), count: 1 },
    ]);
  });
  it("CSV escapes and neutralises formulas", () => {
    const csv = toCsv([{ source: "wallet", chain: "a,b", id: "=HYPERLINK(1)", pair: 'say "hi"', status: "open", unit: "ETH", pnlNative: -0.5, openedAt: 0 }]);
    const line = csv.split("\n")[1]!;
    expect(line).toContain('"a,b"');
    expect(line).toContain("'=HYPERLINK(1)");
    expect(line).toContain('"say ""hi"""');
    expect(line).toContain(",-0.5,");
    expect(line).toContain("1970-01-01T00:00:00.000Z");
  });
});

describe("uniswap v3 valuation", () => {
  const WETH = "0x00000000000000000000000000000000000000ee";
  const TOK = "0x00000000000000000000000000000000000000aa";
  // price of token0 in token1 = 4 → sqrtPriceX96 = 2 · 2^96
  const sqrt = 2n * (1n << 96n);
  it("values both pool orientations in WETH", () => {
    // WETH is token0 (1 WETH = 4 TOK): 1 WETH + 4 TOK = 2 WETH
    expect(valueInWeth({ token0: WETH, token1: TOK, sqrtPriceX96: sqrt }, WETH, e18(1), e18(4))).toBe(e18(2));
    // WETH is token1 (1 TOK = 4 WETH): 1 TOK + 1 WETH = 5 WETH
    expect(valueInWeth({ token0: TOK, token1: WETH, sqrtPriceX96: sqrt }, WETH, e18(1), e18(1))).toBe(e18(5));
    expect(valueInWeth({ token0: TOK, token1: "0x01", sqrtPriceX96: sqrt }, WETH, 1n, 1n)).toBeNull();
  });
  it("turns positions into rows with in-range and the token named first", () => {
    const chain: V3Chain = { name: "Base", chainId: 8453, rpcUrl: "", factory: "", positionManager: "", weth: WETH };
    const p: V3Position = { tokenId: "5", token0: WETH, token1: TOK, symbol0: "WETH", symbol1: "FROG", decimals0: 18, decimals1: 18, fee: 3000, tickLower: -100, tickUpper: 100, tick: 0, liquidity: 1n, amount0: e18(1), amount1: e18(4), fees0: e18(0.1), fees1: 0n, sqrtPriceX96: sqrt };
    expect(v3Rows(chain, "0xme", [p])[0]).toMatchObject({ pair: "FROG/WETH 0.3%", valueNative: 2.1, feesNative: 0.1, inRange: true, wallet: "0xme" });
    expect(v3Rows(chain, "0xme", [{ ...p, tick: 100 }])[0]!.inRange).toBe(false); // upper tick is exclusive
  });
});

describe("stablecoin pairs (Robinhood Chain's USDG stock pairs)", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const chain: V3Chain = { name: "Robinhood Chain", chainId: 4663, rpcUrl: "", factory: "", positionManager: "", weth: "0xee00000000000000000000000000000000000000", stables: [{ address: USDG, decimals: 6 }] };
  // NVDA (18 dec) is token0, USDG (6 dec) token1, NVDA = $200 → raw price = 200e6 / 1e18
  const sqrt = BigInt(Math.round(Math.sqrt(200e6 / 1e18) * 2 ** 48)) * (1n << 48n);
  const base = { tokenId: "1", token0: "0x0000000000000000000000000000000000000aaa", token1: USDG, symbol0: "NVDA", symbol1: "USDG", decimals0: 18, decimals1: 6, fee: 500, tickLower: -10, tickUpper: 10, tick: 0, liquidity: 1n, fees0: 0n, fees1: 1_000_000n, sqrtPriceX96: sqrt };
  it("values them in USD, fees included", () => {
    const [r] = v3Rows(chain, "0xme", [{ ...base, amount0: 10n ** 18n, amount1: 300_000_000n }]);
    expect(r).toMatchObject({ unit: "USD", pair: "NVDA/USDG 0.05%" });
    expect(r!.valueNative!).toBeCloseTo(200 + 300 + 1, 3);
    expect(r!.feesNative!).toBeCloseTo(1, 6);
    expect(r!.tokenPriceNative!).toBeCloseTo(200, 3);
  });
  it("refuses a lookalike 'USDG' at another address", () => {
    const [r] = v3Rows(chain, "0xme", [{ ...base, token1: "0x000000000000000000000000000000000000bad1", amount0: 1n, amount1: 1n }]);
    expect(r!.valueNative).toBeUndefined();
    expect(r!.note).toMatch(/not valued/);
  });
});

describe("dlmm valuation", () => {
  it("bin price and SOL value", () => {
    expect(binPrice(0, 100, 9, 9)).toBe(1);
    expect(binPrice(100, 100, 6, 9)).toBeCloseTo(Math.pow(1.01, 100) * 1e-3, 12);
    const v = dlmmValue({ position: "p", pool: "q", solIsX: false, symbol: "X", solAmt: 1, tokAmt: 1000, solFee: 0.01, tokFee: 10, tokenPriceSol: 0.001, inRange: true });
    expect(v.value).toBeCloseTo(1 + 1 + 0.01 + 0.01);
    expect(v.fees).toBeCloseTo(0.02);
    expect(dlmmWalletRows("Me", [{ position: "p", pool: "q", solIsX: false, symbol: "X", solAmt: 1, tokAmt: 0, solFee: 0, tokFee: 0, tokenPriceSol: 1, inRange: false }])[0]).toMatchObject({ unit: "SOL", valueNative: 1, inRange: false });
  });
});

describe("collect", () => {
  it("merges a bot position with its on-chain value, keeps unknown wallet positions, reports failures", async () => {
    const d1 = tmp();
    const d2 = tmp();
    lpBook(d1);
    dlmmBook(d2);
    const cfg: DashConfig = {
      host: "127.0.0.1", port: 0, password: "", refreshSec: 60, solanaRpc: "x",
      chains: { base: { name: "Base", chainId: 8453, rpcUrl: "x", factory: "x", positionManager: "x", weth: "0xee" } },
      lpBot: { dataDir: d1, chain: "base" },
      dlmmDataDir: d2,
      wallets: [{ chain: "base", address: "0xbot" }, { chain: "solana", address: "SolMe" }],
    };
    const pos = (id: string): V3Position => ({ tokenId: id, token0: "0xee", token1: "0xaa", symbol0: "WETH", symbol1: "FROG", decimals0: 18, decimals1: 18, fee: 3000, tickLower: -10, tickUpper: 10, tick: 0, liquidity: 1n, amount0: e18(1.1), amount1: 0n, fees0: e18(0.02), fees1: 0n, sqrtPriceX96: 1n << 96n });
    const s = await collect(cfg, { v3: async () => [pos("77"), pos("88")], dlmm: async () => { throw new Error("RPC 429"); } });
    const bot = s.rows.find((r) => r.id === "77")!;
    expect(bot).toMatchObject({ source: "lp-bot", depositNative: 1, valueNative: expect.closeTo(1.12), inRange: true, wallet: "0xbot" });
    expect(bot.pnlNative).toBeCloseTo(0.12);
    expect(s.rows.filter((r) => r.id === "77")).toHaveLength(1);
    expect(s.rows.find((r) => r.id === "88")).toMatchObject({ source: "wallet" });
    expect(s.warnings).toEqual([expect.stringContaining("SolMe on solana: RPC 429")]);
  });
  it("adds the bot's leftover token (at the on-chain price) and already-collected fees", () => {
    const bot: Row[] = [{ source: "lp-bot", chain: "Base", id: "5", pair: "x", status: "open", unit: "ETH", depositNative: 1, extra: { collectedNative: 0.05, leftoverRaw: "2000000", tokenDecimals: 6 } }];
    const [m] = mergeRows(bot, [{ source: "wallet", chain: "Base", id: "5", pair: "x", status: "open", unit: "ETH", valueNative: 0.9, feesNative: 0.01, tokenPriceNative: 0.01 }]);
    expect(m!.valueNative).toBeCloseTo(0.9 + 2 * 0.01 + 0.05);
    expect(m!.feesNative).toBeCloseTo(0.06);
    expect(m!.pnlNative).toBeCloseTo(-0.03);
  });
  it("never merges onto paper or closed rows", () => {
    const bot: Row[] = [{ source: "lp-bot", chain: "Base", id: "P1", pair: "x", status: "open", unit: "ETH", paper: true, depositNative: 1 }];
    const out = mergeRows(bot, [{ source: "wallet", chain: "Base", id: "P1", pair: "x", status: "open", unit: "ETH", valueNative: 9 }]);
    expect(out).toHaveLength(2);
    expect(out[0]!.valueNative).toBeUndefined();
  });
});

describe("config", () => {
  it("parses wallets and refuses to listen publicly without a password", () => {
    expect(parseWallets("base:0x1111111111111111111111111111111111111111:main, solana:4Re3Gxt3bJNQmptr9YyFS3CTeHKoSS4S58NvyjhU4XsH")).toHaveLength(2);
    expect(() => parseWallets("eth:0x1")).toThrow();
    expect(() => loadConfig({ HOST: "0.0.0.0", DATA_DIR: tmp() })).toThrow(/DASHBOARD_PASSWORD/);
    expect(loadConfig({ HOST: "0.0.0.0", DASHBOARD_PASSWORD: "correct horse battery", DATA_DIR: tmp(), RPC_BASE: "https://my.rpc" }).chains.base!.rpcUrl).toBe("https://my.rpc");
    expect(() => loadConfig({ LPBOT_DATA: "/x", LPBOT_CHAIN: "mars", DATA_DIR: tmp() })).toThrow(/LPBOT_CHAIN/);
  });
});

describe("server", () => {
  it("requires the password, serves summary and CSV, caches", async () => {
    let loads = 0;
    const summary = cached(async () => (loads++, summarize([{ source: "wallet", chain: "Base", id: "1", pair: "X/ETH", status: "open", unit: "ETH", valueNative: 1 }])), 60_000, 0);
    const srv = createServer({ html: "<p>dash</p>", password: "s3cret-password", summary });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { authorization: "Basic " + Buffer.from("me:s3cret-password").toString("base64") };
    try {
      expect((await fetch(base)).status).toBe(401);
      expect((await fetch(base, { headers: { authorization: "Basic " + Buffer.from("me:wrong").toString("base64") } })).status).toBe(401);
      expect(await (await fetch(base, { headers: auth })).text()).toContain("dash");
      const s = await (await fetch(`${base}/api/summary`, { headers: auth })).json();
      expect(s.totals.ETH.openValue).toBe(1);
      await fetch(`${base}/api/summary`, { headers: auth });
      expect(loads).toBe(1);
      await fetch(`${base}/api/summary?refresh=1`, { headers: auth });
      expect(loads).toBe(2);
      const csv = await fetch(`${base}/api/export.csv`, { headers: auth });
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect((await csv.text()).split("\n")[0]).toContain("source,chain,wallet");
      expect((await fetch(`${base}/api/summary`, { method: "POST", headers: auth })).status).toBe(405);
    } finally {
      srv.close();
    }
  });
});
