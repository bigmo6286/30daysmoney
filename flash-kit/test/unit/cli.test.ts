import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { chainFrom, main, parseArgs } from "../../src/cli";
import { CHAINS, netOfGas, revertReason, routeFrom, loadArtifact, type Quote } from "../../src/arb";

const q: Quote = { loanToken: "0x01", midToken: "0x02", amount: 10n ** 18n, buy: { router: "0xr", fee: 500 }, sell: { router: "0xr", fee: 3000 }, midOut: 10_000n, back: 10n ** 18n + 5n, gross: 5n };

describe("cli args", () => {
  it("parses flags and refuses keys on the command line", () => {
    expect(parseArgs(["arb", "--chain", "base", "--exec", "--yes", "--min-profit", "0.01"])).toEqual({ cmd: "arb", opts: { chain: "base", exec: true, yes: true, "min-profit": "0.01" } });
    expect(() => parseArgs(["arb", "--private-key", "0xabc"])).toThrow(/shell history/);
    expect(() => parseArgs(["arb", "stray"])).toThrow(/unexpected/);
  });
  it("resolves chains with an RPC override", () => {
    expect(chainFrom({ chain: "base" }, { RPC_URL_BASE: "https://mine" }).rpcUrl).toBe("https://mine");
    expect(chainFrom({ chain: "base" }, {}).morpho).toBe(CHAINS.base!.morpho);
    expect(() => chainFrom({ chain: "mars" }, {})).toThrow(/--chain/);
  });
  it("prints help and chains without a network", async () => {
    const out: string[] = [];
    await main(["help"], (s) => out.push(s));
    expect(out.join("\n")).toContain("flash-kit arb");
    await main(["chains"], (s) => out.push(s));
    expect(out.join("\n")).toContain("Robinhood Chain (4663)");
  });
});

describe("route guards", () => {
  it("bounds the buy leg by slippage and sets a short deadline", () => {
    const r = routeFrom(q, 3n, 50, 1_000);
    expect(r.minMidOut).toBe(9_950n);
    expect(r.minProfit).toBe(3n);
    expect(r.deadline).toBe(1_120n);
    expect([r.buyFee, r.sellFee]).toEqual([500, 3000]);
  });
  it("nets gas only when the loan token is WETH", () => {
    expect(netOfGas(10n ** 16n, 300_000n, 10n ** 9n, true)).toBe(10n ** 16n - 3n * 10n ** 14n);
    expect(netOfGas(5n, 1n, 1n, false)).toBeNull();
  });
  it("decodes the executor's custom errors", () => {
    const iface = new ethers.Interface(loadArtifact().abi as ethers.InterfaceAbi);
    const data = iface.encodeErrorResult("NoProfit", [1n, 2n]);
    expect(revertReason(iface, { data })).toBe("NoProfit(1, 2)");
    expect(revertReason(iface, { shortMessage: "execution reverted: Too little received" })).toBe("execution reverted: Too little received");
  });
});
