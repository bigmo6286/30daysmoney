import { describe, expect, it } from "vitest";
import { binsForDownside, depthOf, paperValue, rangeState, solRange } from "../src/range";

describe("range", () => {
  it("sizes the range from the downside and clamps it", () => {
    // 1.01^-52 ≈ 0.596: 52 bins of 1% cover a 40% fall
    expect(binsForDownside(40, 100, 15, 69)).toBe(52);
    expect(Math.pow(1.01, -52)).toBeLessThan(0.6);
    expect(Math.pow(1.01, -51)).toBeGreaterThan(0.6);
    expect(binsForDownside(40, 25, 15, 69)).toBe(69); // tiny bins: capped at one position
    expect(binsForDownside(5, 125, 15, 69)).toBe(15);
  });

  it("puts SOL on the side the token price falls into", () => {
    expect(solRange(1000, 20, false)).toEqual({ minBinId: 980, maxBinId: 1000 });
    expect(solRange(1000, 20, true)).toEqual({ minBinId: 1000, maxBinId: 1020 });
    expect(depthOf(1000, 990, false)).toBe(10); // SOL is Y: token falls → active id falls
    expect(depthOf(1000, 1010, true)).toBe(10); // SOL is X: token falls → active id rises
    expect(rangeState(-1, 20)).toBe("above");
    expect(rangeState(0, 20)).toBe("in");
    expect(rangeState(20, 20)).toBe("in");
    expect(rangeState(21, 20)).toBe("below");
  });

  it("values a single-sided deposit as the price falls through it", () => {
    expect(paperValue(1, 20, -5, 100)).toBeCloseTo(1, 12); // above range: untouched SOL
    expect(paperValue(1, 20, 0, 100)).toBeCloseTo(1, 12);
    const vals = [0, 5, 10, 20, 30, 60].map((d) => paperValue(1, 20, d, 100));
    for (let i = 1; i < vals.length; i++) expect(vals[i]!).toBeLessThan(vals[i - 1]!);
    // fully converted then the token keeps falling: value tracks the token from the average entry
    expect(paperValue(1, 20, 60, 100) / paperValue(1, 20, 30, 100)).toBeCloseTo(Math.pow(1.01, -30), 10);
    // the loss is smaller than holding the token from the top: you bought on the way down
    expect(paperValue(1, 20, 20, 100)).toBeGreaterThan(Math.pow(1.01, -20));
  });
});
