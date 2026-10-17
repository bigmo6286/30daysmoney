import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config";
import { discover, discoveryUrl, parsePool, type Pool } from "../src/auto/discovery";
import { rank } from "../src/auto/screen";
import { rawPool } from "./fixtures";

const s = SettingsSchema.parse({});
const pool = (over: Record<string, unknown> = {}, sym?: string, mint?: string) => parsePool(rawPool(over, sym, mint))!;

describe("discovery parsing", () => {
  it("finds the token side whichever side SOL is on", () => {
    const y = parsePool(rawPool())!;
    expect(y).toMatchObject({ symbol: "FROG", solIsX: false, binStep: 100, feeTvlPct: 1.5, organic: 80, mcapUsd: 2_000_000 });
    const x = parsePool(rawPool({}, "FROG", "Frog111111111111111111111111111111111111111", true))!;
    expect(x).toMatchObject({ symbol: "FROG", solIsX: true });
  });
  it("drops non-SOL and non-DLMM pools, tolerates junk", () => {
    expect(parsePool({ ...rawPool(), token_y: { address: "USDC", symbol: "USDC" } })).toBeNull();
    expect(parsePool({ ...rawPool(), pool_type: "damm" })).toBeNull();
    expect(parsePool({})).toBeNull();
    expect(parsePool({ ...rawPool(), tvl: "12.5", volume: null })).toMatchObject({ tvlUsd: 12.5, volumeUsd: 0 });
  });
  it("builds the server-side filter and reads the data array", async () => {
    const url = decodeURIComponent(discoveryUrl(s));
    expect(url).toContain("timeframe=4h");
    expect(url).toContain("tvl>=10000&&volume>=2000");
    expect(url).toContain("dlmm_bin_step>=80&&dlmm_bin_step<=125");
    const f = (async () => new Response(JSON.stringify({ data: [rawPool(), { junk: true }] }))) as unknown as typeof fetch;
    expect(await discover(s, f)).toHaveLength(1);
  });
});

describe("rank", () => {
  it("rejects with a reason per threshold", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ tvl: 100 }, /TVL/],
      [{ fee_active_tvl_ratio: 0.1 }, /fee\/TVL/],
      [{ base_token_holders: 10 }, /holders/],
      [{ dlmm_bin_step: 20 }, /bin step/],
      [{ base_token_has_critical_warnings: true }, /critical/],
      [{ volatility: 0 }, /volatility/],
    ];
    for (const [over, re] of cases) {
      const { ranked, rejected } = rank([pool(over)], s);
      expect(ranked).toHaveLength(0);
      expect(rejected[0]!.reason).toMatch(re);
    }
    const young = parsePool({ ...rawPool(), token_x: { ...rawPool().token_x, created_at: Date.now() - 60_000 } })!;
    expect(rank([young], s).rejected[0]!.reason).toMatch(/younger/);
  });

  it("ranks by yield × organic, keeps the best pool per token, flags same-symbol rivals", () => {
    const a = pool({ fee_active_tvl_ratio: 1.0 }, "AAA", "Mint1");
    const a2 = { ...pool({ fee_active_tvl_ratio: 2.0 }, "AAA", "Mint1"), address: "PoolAAA-2" } as Pool;
    const b = pool({ fee_active_tvl_ratio: 1.8 }, "BBB", "Mint2");
    const copy = { ...pool({ fee_active_tvl_ratio: 3.0 }, "BBB", "Mint3"), address: "PoolBBB-copy" } as Pool; // same ticker, other mint
    const { ranked } = rank([a, a2, b, copy], s);
    // score = fee/TVL × organic(0.8), halved for PVP: AAA-2 1.6 · BBB-copy 1.2 · BBB 0.72
    expect(ranked.map((r) => r.pool.address)).toEqual(["PoolAAA-2", "PoolBBB-copy", "PoolBBBY"]);
    expect(ranked.filter((r) => r.pool.mint === "Mint1")).toHaveLength(1);
    expect(ranked.find((r) => r.pool.mint === "Mint2")!.pvp).toBe(true);
    expect(ranked.find((r) => r.pool.mint === "Mint1")!.pvp).toBe(false);
  });
});
