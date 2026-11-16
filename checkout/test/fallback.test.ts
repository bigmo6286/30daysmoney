import { describe, expect, it } from "vitest";
import { pollWithFallback, redact } from "../src/watch/fallback";

const transfer = { chain: "solana" as const, txid: "t", amountMicro: 1, from: "f", at: 0 };

describe("RPC fallback", () => {
  it("uses the first RPC when it works", async () => {
    const r = await pollWithFallback(["a", "b"], (url) => ({ poll: async () => [transfer], state: { url } }));
    expect(r).toEqual({ transfers: [transfer], state: { url: "a" }, url: "a" });
  });
  it("polls the next RPC from the same state when the first throws", async () => {
    const fails: string[] = [];
    const made: string[] = [];
    const r = await pollWithFallback(["alchemy", "public"], (url) => {
      made.push(url);
      return { poll: async () => (url === "alchemy" ? Promise.reject(new Error("HTTP 429")) : [transfer]), state: { url } };
    }, (url) => void fails.push(url));
    expect(made).toEqual(["alchemy", "public"]);
    expect(fails).toEqual(["alchemy"]);
    expect(r.url).toBe("public");
    expect(r.transfers).toEqual([transfer]);
  });
  it("skips duplicates and blanks, and throws the last error when all fail", async () => {
    const made: string[] = [];
    await expect(pollWithFallback(["x", "", "x", "y"], (url) => (made.push(url), { poll: async () => Promise.reject(new Error(`down ${url}`)), state: {} }))).rejects.toThrow("down y");
    expect(made).toEqual(["x", "y"]);
  });
  it("keeps keys out of logs", () => {
    expect(redact("https://solana-mainnet.g.alchemy.com/v2/abc123")).toBe("https://solana-mainnet.g.alchemy.com/v2/…");
    expect(redact("https://rpc.example/?api-key=abc&x=1")).toBe("https://rpc.example/?api-key=…&x=1");
    expect(redact("https://mainnet.base.org")).toBe("https://mainnet.base.org");
  });
});
