import { describe, expect, it } from "vitest";
import { computeRange, isInRange, tokenPriceAtTick, tokenShareForRange } from "../../src/core/range";

const base = { tickSpacing: 60, widthPct: 20, singleOffsetPct: 1 };

describe("computeRange", () => {
  for (const quoteIsToken0 of [false, true]) {
    for (const tick of [-200_000, -12_345, 0, 7, 100_123]) {
      it(`in-range straddles price (quoteIsToken0=${quoteIsToken0}, tick=${tick})`, () => {
        const r = computeRange("inrange", { ...base, tick, quoteIsToken0 });
        expect(Math.abs(r.tickLower % 60)).toBe(0);
        expect(Math.abs(r.tickUpper % 60)).toBe(0);
        expect(isInRange(tick, r)).toBe(true);
        // ±20% in price ≈ ±1823 / −2231 ticks
        expect(r.tickUpper - r.tickLower).toBeGreaterThan(3900);
        expect(r.tickUpper - r.tickLower).toBeLessThan(4300);
      });

      it(`single-side holds only the quote token and sits below the token price (quoteIsToken0=${quoteIsToken0}, tick=${tick})`, () => {
        const r = computeRange("single", { ...base, tick, quoteIsToken0 });
        expect(Math.abs(r.tickLower % 60)).toBe(0);
        expect(Math.abs(r.tickUpper % 60)).toBe(0);
        expect(r.tickUpper).toBeGreaterThan(r.tickLower);
        if (quoteIsToken0) expect(r.tickLower).toBeGreaterThan(tick); // only token0 above the price
        else expect(r.tickUpper).toBeLessThanOrEqual(tick); // only token1 below the price
        const p = tokenPriceAtTick(tick, quoteIsToken0, 18, 18);
        const a = tokenPriceAtTick(r.tickLower, quoteIsToken0, 18, 18);
        const b = tokenPriceAtTick(r.tickUpper, quoteIsToken0, 18, 18);
        expect(Math.max(a, b)).toBeLessThan(p);
        expect(Math.min(a, b)).toBeGreaterThan(p * 0.75);
      });
    }
  }

  it("clamps at the tick bounds", () => {
    const r = computeRange("inrange", { ...base, widthPct: 90, tick: 887_000, quoteIsToken0: false });
    expect(r.tickUpper).toBeLessThanOrEqual(887_272);
    expect(r.tickLower).toBeLessThan(r.tickUpper);
  });
});

describe("tokenShareForRange", () => {
  it("is ~50% for a symmetric (in tick space) range", () => {
    expect(tokenShareForRange(0, { tickLower: -6000, tickUpper: 6000 }, false)).toBeCloseTo(0.5, 2);
  });
  it("is 0/1 outside the range", () => {
    const r = { tickLower: 600, tickUpper: 1200 };
    expect(tokenShareForRange(0, r, false)).toBe(1); // price below range → only token0 (= token)
    expect(tokenShareForRange(0, r, true)).toBe(0); // only token0 (= quote)
    expect(tokenShareForRange(5000, r, false)).toBe(0);
  });
  it("mirrors between orderings", () => {
    const r = { tickLower: -3000, tickUpper: 1200 };
    expect(tokenShareForRange(0, r, false) + tokenShareForRange(0, r, true)).toBeCloseTo(1, 10);
  });
});
