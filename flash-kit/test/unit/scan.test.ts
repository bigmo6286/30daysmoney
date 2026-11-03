import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { marketAuthority, type Reserve } from "../../src/sol/kamino";
import { batchFor, cycleOrder, HOT, rotation, MIDS, payoutTarget, pickMids, pickTargets, preflight, priorityFee, recordPass, sweepInstructions, type Target } from "../../src/sol/scan";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const market = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const r: Reserve = { address: Keypair.generate().publicKey, market, mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), supplyVault: Keypair.generate().publicKey, feeVault: Keypair.generate().publicKey, marketAuthority: marketAuthority(market), tokenProgram: TOKEN_PROGRAM_ID, decimals: 6 };
const conn = (lamports: number, usdc: string | null) =>
  ({ getBalance: async () => lamports, getTokenAccountBalance: async () => (usdc === null ? Promise.reject(new Error("could not find account")) : { value: { amount: usdc } }) }) as never;

describe("scan preflight", () => {
  const me = Keypair.generate().publicKey;
  it("runs only for the expected wallet, with SOL for fees and no USDC", async () => {
    expect(await preflight(conn(50_000_000, null), r, me, me.toBase58())).toBeNull();
    expect(await preflight(conn(50_000_000, "0"), r, me, me.toBase58())).toBeNull();
    expect(await preflight(conn(50_000_000, null), r, me, Keypair.generate().publicKey.toBase58())).toMatch(/refusing/);
    expect(await preflight(conn(5_000_000, null), r, me, me.toBase58())).toMatch(/needs at least 0.02/);
    expect(await preflight(conn(50_000_000, "1500000"), r, me, me.toBase58())).toMatch(/holds 1.5 USDC: move it out/);
  });

  it("watched tokens are valid Solana mints", () => {
    for (const m of Object.values(MIDS)) expect(() => new PublicKey(m)).not.toThrow();
  });

  it("picks verified, liquid, classic-program tokens; skips stables, SOL, Token-2022 and duplicates", () => {
    const t = (symbol: string, id: string, o: object = {}) => ({ id, symbol, isVerified: true, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", liquidity: 1e6, usdPrice: 3, ...o });
    const mids = pickMids([
      [t("JUP", "J1"), t("USDC", "U1", { usdPrice: 1 }), t("SOL", "S1", { usdPrice: 180 }), t("NEWUSD", "N1", { usdPrice: 1.001 })],
      [t("JUP", "J1"), t("T22", "T1", { tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), t("THIN", "L1", { liquidity: 5_000 }), t("NV", "V1", { isVerified: false }), t("JUP", "J2")],
    ]);
    expect(mids).toEqual({ JUP: "J1", "JUP·J2": "J2" });
  });

  it("rotates through the whole list in batches of 8, one batch per 5 minutes", () => {
    const mids = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`T${i}`, `m${String(i).padStart(2, "0")}`]));
    const seen = new Set<string>();
    for (let k = 0; k < 3; k++) {
      const b = batchFor(mids, k * 300_000);
      expect(b.length).toBeLessThanOrEqual(8);
      b.forEach(([, m]) => seen.add(m));
    }
    expect(seen.size).toBe(20);
    expect(batchFor(mids, 3 * 300_000)).toEqual(batchFor(mids, 0)); // wraps around
  });

  it("payout address: optional, must be a Solana address, and not the bot wallet", () => {
    const me = Keypair.generate().publicKey;
    const main = Keypair.generate().publicKey;
    expect(payoutTarget({}, me)).toBeNull();
    expect(payoutTarget({ ARB_PAYOUT_ADDRESS: ` ${main.toBase58()} ` }, me)!.equals(main)).toBe(true);
    expect(() => payoutTarget({ ARB_PAYOUT_ADDRESS: "0x51F0373A68B2Fa2aa61b41AeF13d5B74Aa1967A7" }, me)).toThrow(/Solana wallet, not 0x/);
    expect(() => payoutTarget({ ARB_PAYOUT_ADDRESS: me.toBase58() }, me)).toThrow(/bot wallet itself/);
  });

  it("sweep: creates the payout wallet's USDC account if needed, then moves the whole amount, signed by the bot only", () => {
    const me = Keypair.generate().publicKey;
    const main = Keypair.generate().publicKey;
    const [create, transfer] = sweepInstructions(r, me, main, 1_234_567n);
    const dst = getAssociatedTokenAddressSync(r.mint, main, true);
    expect(create!.keys.some((k) => k.pubkey.equals(dst))).toBe(true);
    expect(transfer!.keys[0]!.pubkey.equals(getAssociatedTokenAddressSync(r.mint, me, true))).toBe(true);
    expect(transfer!.keys[2]!.pubkey.equals(dst)).toBe(true);
    expect(transfer!.data.readBigUInt64LE(1)).toBe(1_234_567n);
    expect(transfer!.data[9]).toBe(6);
    expect(transfer!.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([me.toBase58()]);
  });

  it("stats: one row per UTC day, totals add up, keeps the closest call and last problem, 7 days max", () => {
    const T = Date.UTC(2026, 9, 31, 6);
    const pass = (o: object) => ({ checked: 16, candidates: 0, sent: [], notes: ["batch: A, B (of 40)"], ...o });
    let d = recordPass([], pass({ best: { usd: -0.6, sym: "JUP 200" }, sol: 0.09 }), T);
    d = recordPass(d, pass({ best: { usd: -0.2, sym: "WIF 200" }, candidates: 1, notes: ["batch: x", "WIF 200: quoted 0.1 but simulated -0.3"] }), T + 300_000);
    d = recordPass(d, pass({ sent: [{ sig: "s", profit: "0.12", route: "r" }], paidOut: 0.12 }), T + 600_000);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ day: "2026-10-31", runs: 3, quotes: 48, candidates: 1, sent: 1, profit: 0.12, paidOut: 0.12, best: { usd: -0.2, sym: "WIF 200" }, sol: 0.09, lastNote: "WIF 200: quoted 0.1 but simulated -0.3", errors: 0 });
    d = recordPass(d, pass({ notes: ["wallet has 0.01 SOL; needs at least 0.02 for fees"] }), T + 86_400_000);
    expect(d.map((x) => x.day)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(d[1]!.errors).toBe(1);
    for (let i = 2; i < 12; i++) d = recordPass(d, pass({}), T + i * 86_400_000);
    expect(d).toHaveLength(7);
  });

  it("rotation covers the whole list, starting at this run's batch", () => {
    const mids = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`T${i}`, `m${String(i).padStart(2, "0")}`]));
    const order = rotation(mids, 300_000);
    expect(order).toHaveLength(20);
    expect(order.slice(0, 8)).toEqual(batchFor(mids, 300_000));
    expect(new Set(order.map(([, m]) => m)).size).toBe(20);
  });
});

describe("movers first", () => {
  const tok = (symbol: string, id: string, m5: number, h1: number) => ({ id, symbol, isVerified: true, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", liquidity: 1e6, usdPrice: 3, stats5m: { priceChange: m5 }, stats1h: { priceChange: h1 } });

  it("scores |5m| + |1h|/4 and keeps the larger score for a token listed twice", () => {
    const ts = pickTargets([[tok("A", "a1", -2, 4)], [tok("A", "a1", 0.5, 0), tok("B", "b1", 0, 0)]]);
    expect(ts).toEqual([
      { sym: "A", id: "a1", vol: 3 },
      { sym: "B", id: "b1", vol: 0 },
    ]);
  });

  it("puts the hottest movers in every cycle and rotates the rest", () => {
    const targets: Target[] = Array.from({ length: 30 }, (_, i) => ({ sym: `T${i}`, id: `id${String(i).padStart(2, "0")}`, vol: i < 10 ? 10 - i : 0 }));
    const c0 = cycleOrder(targets, 0, 0);
    const c1 = cycleOrder(targets, 1, 0);
    expect(c0.slice(0, HOT).map((t) => t.sym)).toEqual(["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    expect(c1.slice(0, HOT)).toEqual(c0.slice(0, HOT));
    const rest0 = c0.slice(HOT).map((t) => t.id);
    const rest1 = c1.slice(HOT).map((t) => t.id);
    expect(rest0.length).toBeGreaterThan(0);
    expect(rest0.some((id) => rest1.includes(id))).toBe(false);
  });

  it("never treats a still token as hot", () => {
    const flat: Target[] = [{ sym: "X", id: "x", vol: 0 }];
    expect(cycleOrder(flat, 0, 0)).toEqual(flat);
  });
});

describe("priority fee", () => {
  it("bids a quarter of the profit in SOL, spread over the compute units", () => {
    // $0.40 profit at $200/SOL → $0.10 tip = 0.0005 SOL = 500,000 lamports
    expect(priorityFee(0.4, 200, 500_000)).toEqual({ lamports: 500_000, microLamports: 1_000_000 });
  });
  it("caps the tip at 0.002 SOL", () => {
    expect(priorityFee(100, 200, 1_000_000).lamports).toBe(2_000_000);
  });
  it("bids nothing on bad input", () => {
    for (const [p, s, c] of [[0, 200, 1e5], [-1, 200, 1e5], [1, 0, 1e5], [1, 200, 0], [NaN, 200, 1e5]]) expect(priorityFee(p!, s!, c!)).toEqual({ lamports: 0, microLamports: 0 });
  });
});
