import { describe, expect, it } from "vitest";
import { retry } from "../src/retry";

describe("retry", () => {
  const noSleep = async () => {};
  it("returns as soon as a try succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const r = await retry(async () => (++n < 3 ? Promise.reject(new Error("fetch failed")) : "ok"), 3, 2_000, async (ms) => void waits.push(ms));
    expect(r).toBe("ok");
    expect(n).toBe(3);
    expect(waits).toEqual([2_000, 4_000]);
  });
  it("rethrows the last error after the last try", async () => {
    let n = 0;
    await expect(retry(async () => Promise.reject(new Error(`fail ${++n}`)), 3, 1, noSleep)).rejects.toThrow("fail 3");
  });
});
