import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { marketAuthority, type Reserve } from "../../src/sol/kamino";
import { MIDS, preflight } from "../../src/sol/scan";

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
});
