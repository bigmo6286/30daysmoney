import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { TickMath } from "@uniswap/v3-sdk";
import { checkLicense } from "../../web/license";
import { daily, historyCsv, record, trustworthy, type Snapshot } from "../../web/history";
import { kindOf } from "../../web/load";
import { amountsFor, feesOwed, unpackInfo } from "../../src/sources/univ4";
import { summarize, type Row } from "../../src/model";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// a throwaway signing key, in the shape checkout issues: base64url(JSON) "." base64url(sig over the body)
const secret = ed25519.utils.randomPrivateKey();
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(ed25519.getPublicKey(secret))]).toString("base64");
const issue = (payload: object, key = secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${Buffer.from(ed25519.sign(new TextEncoder().encode(body), key)).toString("base64url")}`;
};
const lic = { order: "o1", product: "pnl-pro", contact: "@me", issued: 1_000 };

describe("checkLicense", () => {
  it("accepts a PnL Pro key until it expires, and says when it did", () => {
    const k = issue({ ...lic, expires: 10 * DAY });
    expect(checkLicense(k, 5 * DAY, spki)).toEqual({ pro: true, license: { ...lic, expires: 10 * DAY } });
    expect(checkLicense(k, 11 * DAY, spki)).toEqual({ pro: false, reason: "this key expired on 1970-01-11" });
  });

  it("accepts lifetime and bot keys with no expiry", () => {
    for (const product of ["pnl-lifetime", "lp-bot", "dlmm-agent-setup"]) expect(checkLicense(issue({ ...lic, product }), Date.now(), spki).pro).toBe(true);
  });

  it("rejects other products, other signers, tampering and junk", () => {
    expect(checkLicense(issue({ ...lic, product: "flash-guide" }), 0, spki)).toEqual({ pro: false, reason: "this key is for flash-guide" });
    expect(checkLicense(issue(lic, ed25519.utils.randomPrivateKey()), 0, spki)).toEqual({ pro: false, reason: "this key isn't valid" });
    const [, sig] = issue(lic).split(".");
    const forged = Buffer.from(JSON.stringify({ ...lic, product: "pnl-lifetime" })).toString("base64url");
    expect(checkLicense(`${forged}.${sig}`, 0, spki).pro).toBe(false);
    expect(checkLicense("garbage", 0, spki).pro).toBe(false);
    expect(checkLicense("a.b", 0, spki).pro).toBe(false);
    expect(checkLicense("  ", 0, spki)).toEqual({ pro: false, reason: "no key" });
  });

  it("verifies against the real checkout key by default", () => {
    expect(checkLicense(issue(lic)).pro).toBe(false); // signed by the throwaway key, not checkout's
  });
});

const row = (o: Partial<Row>): Row => ({ source: "wallet", chain: "Base", wallet: "0xa", id: "1", pair: "X/Y", status: "open", unit: "USD", valueNative: 100, feesNative: 1, ...o }) as Row;

describe("history", () => {
  it("keeps one reading per unit per hour, newest wins, and drops readings older than 180 days", () => {
    let h: Snapshot[] = [{ t: 0, unit: "USD", value: 1, fees: 0, positions: 1 }];
    const at = 200 * DAY;
    h = record(h, summarize([row({})], [], at));
    h = record(h, summarize([row({ valueNative: 150 }), row({ id: "2", unit: "ETH", valueNative: 2, feesNative: 0.1 })], [], at + 60_000));
    expect(h).toEqual([
      { t: at, unit: "ETH", value: 2, fees: 0.1, positions: 1 },
      { t: at, unit: "USD", value: 150, fees: 1, positions: 1 },
    ]);
  });

  it("skips units with no valued open position", () => {
    expect(record([], summarize([row({ status: "closed" }), row({ id: "2", valueNative: undefined })], [], DAY))).toEqual([]);
  });

  it("daily keeps the last reading of each UTC day; CSV has a header and one line per reading", () => {
    const h: Snapshot[] = [
      { t: 0, unit: "USD", value: 1, fees: 0, positions: 1 },
      { t: 5 * HOUR, unit: "USD", value: 2, fees: 0, positions: 1 },
      { t: DAY, unit: "USD", value: 3, fees: 0, positions: 1 },
    ];
    expect(daily(h).map((s) => s.value)).toEqual([2, 3]);
    expect(historyCsv(h).split("\n")).toEqual(["time,unit,value,unclaimed_fees,positions", "1970-01-01T00:00:00.000Z,USD,1,0,1", "1970-01-01T05:00:00.000Z,USD,2,0,1", "1970-01-02T00:00:00.000Z,USD,3,0,1", ""]);
  });

  it("only records a refresh whose failed sources never held positions", () => {
    const rows = [row({})];
    expect(trustworthy({ rows, failed: [] }, {})).toBe(true);
    expect(trustworthy({ rows, failed: ["0xa|Arbitrum One v3"] }, { "0xa|Arbitrum One v3": 0 })).toBe(true);
    expect(trustworthy({ rows, failed: ["0xa|Base v3"] }, { "0xa|Base v3": 2 })).toBe(false);
    expect(trustworthy({ rows: [], failed: [] }, {})).toBe(false);
  });
});

describe("kindOf", () => {
  it("tells EVM from Solana addresses", () => {
    expect(kindOf(" 0xe5a3c204d05677f40be079d1a596f068a2c6c258 ")).toBe("evm");
    expect(kindOf("48wB1SzMa5mMQgjvpFWiM28myDnu7u1xTLRGgZcmAHk1")).toBe("solana");
    expect(kindOf("0x123")).toBe(null);
    expect(kindOf("hello world")).toBe(null);
  });
});

describe("univ4 math", () => {
  it("unpacks the PositionManager's packed tick range, negatives included", () => {
    const pack = (lo: number, hi: number) => (BigInt.asUintN(24, BigInt(hi)) << 32n) | (BigInt.asUintN(24, BigInt(lo)) << 8n) | 0xabn;
    expect(unpackInfo(pack(-887220, 887220) | (123n << 56n))).toEqual({ tickLower: -887220, tickUpper: 887220 });
    expect(unpackInfo(pack(-60, -10))).toEqual({ tickLower: -60, tickUpper: -10 });
  });

  it("fees owed are growth × liquidity / 2^128, wrapping around 2^256 like the contract", () => {
    const Q128 = 1n << 128n;
    expect(feesOwed(1000n, 5n * Q128, 2n * Q128)).toBe(3000n);
    expect(feesOwed(1000n, Q128, (1n << 256n) - Q128)).toBe(2000n); // inside wrapped past zero
    expect(feesOwed(0n, 5n * Q128, 0n)).toBe(0n);
  });

  it("amounts: all token0 below range, all token1 above, both inside", () => {
    const L = 10n ** 18n;
    const at = (tick: number) => BigInt(TickMath.getSqrtRatioAtTick(tick).toString());
    const below = amountsFor(L, at(-200), -200, -100, 100);
    const above = amountsFor(L, at(200), 200, -100, 100);
    const mid = amountsFor(L, at(0), 0, -100, 100);
    expect(below.amount1).toBe(0n);
    expect(above.amount0).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    // symmetric range at price 1: half of each side's full amount, give or take rounding
    expect(Number(mid.amount0) / Number(below.amount0)).toBeCloseTo(0.5, 2);
    expect(Number(mid.amount1) / Number(above.amount1)).toBeCloseTo(0.5, 2);
  });
});
