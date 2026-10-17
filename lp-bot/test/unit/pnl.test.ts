import { describe, expect, it } from "vitest";
import { computePnl, feesFromGrowth, priceE18FromSqrt, tokenToQuote } from "../../src/core/pnl";
import { eth, signedEth, price, feeTier, age } from "../../src/core/format";

const E18 = 10n ** 18n;
const Q96 = 1n << 96n;

describe("priceE18FromSqrt", () => {
  it("price 1 with equal decimals", () => {
    expect(priceE18FromSqrt(Q96, false, 18)).toBe(E18);
    expect(priceE18FromSqrt(Q96, true, 18)).toBe(E18);
  });
  it("handles orientation (token1 = 4 × token0)", () => {
    const sqrt = 2n * Q96; // raw price token1/token0 = 4
    expect(priceE18FromSqrt(sqrt, false, 18)).toBe(4n * E18); // token0 = token: 1 token = 4 ETH
    expect(priceE18FromSqrt(sqrt, true, 18)).toBe(E18 / 4n); // token1 = token: 1 token = 0.25 ETH
  });
  it("handles token decimals (6-dec token at 0.0005 ETH)", () => {
    // token0 = token (6 dec), quote token1 (18 dec): raw price = 0.0005e18 / 1e6 = 5e8
    const raw = 500_000_000n;
    const sqrt = BigInt(Math.floor(Math.sqrt(Number(raw)) * 2 ** 48)) * (1n << 48n);
    const p = priceE18FromSqrt(sqrt, false, 6);
    expect(Number(p) / 1e18).toBeCloseTo(0.0005, 8);
  });
});

describe("computePnl", () => {
  it("values principal + fees and compares with HODL", () => {
    const r = computePnl({
      depositQuote: E18,
      depositToken: 500n * E18,
      depositQuoteInPosition: E18 / 2n,
      nowToken: 400n * E18,
      nowQuote: (E18 * 6n) / 10n,
      feeToken: 10n * E18,
      feeQuote: E18 / 100n,
      priceQuotePerTokenE18: E18 / 1000n, // 1 token = 0.001 ETH
      tokenDecimals: 18,
    });
    expect(r.feesQuote).toBe(E18 / 100n + E18 / 100n);
    expect(r.valueQuote).toBe((E18 * 6n) / 10n + (E18 * 4n) / 10n + r.feesQuote);
    expect(r.pnlQuote).toBe(r.valueQuote - E18);
    expect(r.pnlPct).toBeCloseTo(2, 6);
    expect(r.hodlQuote).toBe(E18 / 2n + E18 / 2n);
  });
  it("tokenToQuote respects decimals", () => {
    expect(tokenToQuote(2_000_000n, E18 / 2n, 6)).toBe(E18);
  });
});

describe("feesFromGrowth", () => {
  it("scales by liquidity / 2^128", () => {
    expect(feesFromGrowth(10n, 0n, 5n << 128n)).toBe(50n);
  });
  it("handles uint256 wraparound", () => {
    const max = (1n << 256n) - 1n;
    expect(feesFromGrowth(1n, max - (1n << 128n) + 1n, 1n << 128n)).toBe(2n);
  });
});

describe("format", () => {
  it("eth", () => {
    expect(eth(E18)).toBe("1");
    expect(eth(1234567n * 10n ** 12n)).toBe("1.23456");
    expect(eth(-E18 / 2n)).toBe("-0.5");
    expect(signedEth(E18 / 4n)).toBe("+0.25");
  });
  it("misc", () => {
    expect(price(0.00000123)).toBe("1.230e-6");
    expect(feeTier(3000)).toBe("0.3%");
    expect(feeTier(10000)).toBe("1%");
    expect(age(90 * 60_000)).toBe("1h 30m");
  });
});
