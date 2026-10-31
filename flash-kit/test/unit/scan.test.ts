import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { marketAuthority, type Reserve } from "../../src/sol/kamino";
import { batchFor, MIDS, pickMids, preflight } from "../../src/sol/scan";

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
});
