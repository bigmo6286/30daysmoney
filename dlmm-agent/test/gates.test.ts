import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { mintFacts } from "../src/chain/facts";
import { loadKeypair } from "../src/chain/solana";
import { CachedScreener, JevScreener, verdict } from "../src/auto/jev";
import { parsePool } from "../src/auto/discovery";
import { rawPool } from "./fixtures";

const MINT = "So11111111111111111111111111111111111111112"; // any valid base58 key works for the fake RPC
const POOL = "PoolOwner";

function fakeConn(info: Record<string, unknown>, extensions: unknown[] = [], program = "spl-token-2022") {
  return {
    getParsedAccountInfo: async () => ({ value: { data: { program, parsed: { info: { decimals: 6, supply: "1000000", mintAuthority: null, freezeAuthority: null, extensions, ...info } } } } }),
    getTokenLargestAccounts: async () => ({ value: [{ address: "A", amount: "400000" }, { address: "B", amount: "150000" }, { address: "C", amount: "50000" }] }),
    getMultipleParsedAccounts: async () => ({ value: [{ data: { parsed: { info: { owner: POOL } } } }, { data: { parsed: { info: { owner: "whale" } } } }, { data: { parsed: { info: { owner: "fish" } } } }] }),
  } as any;
}

describe("mint facts", () => {
  it("clean mint: no flags, pool share split from holder concentration", async () => {
    const f = await mintFacts(fakeConn({}), MINT, POOL);
    expect(f.redFlags).toEqual([]);
    expect(f.inPoolPct).toBe(40);
    expect(f.top10Pct).toBe(20);
  });
  it("flags freeze authority and dangerous Token-2022 extensions", async () => {
    const f = await mintFacts(
      fakeConn({ freezeAuthority: "Dev" }, [
        { extension: "permanentDelegate", state: { delegate: "Dev" } },
        { extension: "transferHook", state: { programId: "Hook" } },
        { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 500 } } },
      ]),
      MINT,
      POOL,
    );
    expect(f.redFlags).toEqual([
      "freeze authority set (holders can be frozen)",
      "permanent delegate (tokens can be moved from any wallet)",
      "transfer hook program",
      "transfer fee 5%",
    ]);
    expect(f.transferFeeBps).toBe(500);
  });
});

describe("holder lookup failure", () => {
  it("reports unknown (null), never 0%, when the largest-accounts call fails", async () => {
    const conn = { ...fakeConn({}), getTokenLargestAccounts: async () => { throw new Error("429 Too Many Requests"); } };
    const f = await mintFacts(conn as any, MINT, POOL);
    expect(f.top10Pct).toBeNull();
    expect(f.inPoolPct).toBeNull();
  });
  it("the gate treats unknown concentration as 'retry later', not as a pass", async () => {
    const { TokenGates } = await import("../src/auto/gates");
    const { SettingsSchema } = await import("../src/config");
    const conn = { ...fakeConn({}, [], "spl-token"), getTokenLargestAccounts: async () => { throw new Error("429"); } };
    const jup = { roundTripLossPct: async () => { throw new Error("must not be reached"); } };
    const g = await new TokenGates(conn as any, jup as any).check(parsePool(rawPool())!, 0.1, SettingsSchema.parse({ requireMintRenounced: false }), []);
    expect(g).toMatchObject({ ok: false, error: true, reason: expect.stringContaining("unavailable") });
  });
});

describe("jev", () => {
  const pool = parsePool(rawPool())!;
  const facts = { mint: pool.mint, program: "spl-token", decimals: 6, supply: "1", mintAuthority: null, freezeAuthority: null, extensions: [], transferFeeBps: 0, top10Pct: 12, inPoolPct: 30, redFlags: [] } as any;
  const reply = { model: "jev-1.13.0", answers: { copycat: { type: "noul", noul: 0.1 }, rug_signs: { type: "noul", noul: 0.2 }, risk: { type: "score", score: 2 } } };

  it("sends one typed request with facts + market, maps answers, caches per mint", async () => {
    const bodies: any[] = [];
    const f = (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), new Response(JSON.stringify(reply)))) as unknown as typeof fetch;
    const jev = new CachedScreener(new JevScreener("k", "jev-latest", f));
    const a = await jev.assess(facts, pool, ["BONK"]);
    expect(a).toEqual({ copycat: 0.1, rugSigns: 0.2, risk: 0.5, source: "jev-1.13.0" });
    await jev.assess(facts, pool, ["BONK"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].state.token).toMatchObject({ symbol: "FROG", mint_authority: "revoked", top10_holders_pct: 12 });
    expect(bodies[0].state.market).toMatchObject({ fee_tvl_pct: 1.5, bin_step: 100 });
    expect(Object.keys(bodies[0].questions)).toEqual(["copycat", "rug_signs", "risk"]);
    expect(jev.peek(pool.mint)).toEqual(a);
  });
  it("retries 429, fails fast on 401", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response("", { status: 429 }) : new Response(JSON.stringify(reply)))) as unknown as typeof fetch;
    await expect(new JevScreener("k", "jev-latest", flaky).assess(facts, pool, [])).resolves.toMatchObject({ risk: 0.5 });
    let m = 0;
    const bad = (async () => (m++, new Response("no", { status: 401 }))) as unknown as typeof fetch;
    await expect(new JevScreener("k", "jev-latest", bad).assess(facts, pool, [])).rejects.toThrow("401");
    expect(m).toBe(1);
  });
  it("verdict uses the settings' percentages", () => {
    const t = { maxCopycatPct: 50, maxRugPct: 40, maxRiskPct: 60 };
    expect(verdict({ copycat: 0.1, rugSigns: 0.2, risk: 0.5, source: "" }, t)).toEqual({ ok: true });
    expect(verdict({ copycat: 0.1, rugSigns: 0.45, risk: 0.5, source: "" }, t)).toEqual({ ok: false, reason: "rug signs 45%" });
  });
});

describe("wallet key", () => {
  it("reads base58 and JSON byte-array keys", () => {
    const kp = Keypair.generate();
    expect(loadKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypair(JSON.stringify([...kp.secretKey])).publicKey.equals(kp.publicKey)).toBe(true);
  });
});
