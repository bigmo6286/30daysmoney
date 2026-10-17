import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { v4Depth } from "../../src/chain/v4";

describe("v4 depth", () => {
  it("is the ETH that moves the price 10% at the current liquidity", () => {
    // 1 ETH = 4e8 tokens → √P = 20000; L chosen so the virtual ETH reserve is 100 ETH
    const sqrtP = 20000n << 96n;
    const L = 100n * 10n ** 18n * 20000n;
    const d = Number(ethers.formatEther(v4Depth(L, sqrtP)));
    expect(d).toBeCloseTo(100 * (1 - 1 / Math.sqrt(1.1)), 3);
    expect(v4Depth(L, 0n)).toBe(0n);
  });
});
