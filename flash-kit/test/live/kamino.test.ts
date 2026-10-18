/**
 * Live, read-only: builds Kamino flash loans against Solana mainnet and simulates them (nothing is
 * signed or sent). `npm run test:live` (SOLANA_RPC_URL to use your own RPC).
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { available, flashTransaction, loadReserve, simulateFlash, RESERVES } from "../../src/sol/kamino";

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");

/** a wallet (on-curve owner, holding USDC in its ATA) to simulate as: pays the flash fee */
async function usdcHolder(mint: PublicKey): Promise<PublicKey> {
  const big = await conn.getTokenLargestAccounts(mint);
  for (const a of big.value.slice(0, 20)) {
    const info = (await conn.getParsedAccountInfo(a.address)).value?.data as { parsed?: { info?: { owner?: string } } } | undefined;
    const owner = info?.parsed?.info?.owner;
    if (!owner) continue;
    const o = new PublicKey(owner);
    if (PublicKey.isOnCurve(o.toBytes()) && getAssociatedTokenAddressSync(mint, o, true).equals(a.address)) return o;
  }
  throw new Error("no simple USDC holder found among the largest accounts");
}

describe("Kamino flash loans (Solana mainnet, simulated)", () => {
  it("reads and checks the main-market reserves", async () => {
    const usdc = await loadReserve(conn, "USDC");
    expect(usdc.mint.toBase58()).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(usdc.decimals).toBe(6);
    expect(await available(conn, usdc)).toBeGreaterThan(1_000_000n * 10n ** 6n);
    const sol = await loadReserve(conn, "SOL");
    expect(sol.mint.toBase58()).toBe("So11111111111111111111111111111111111111112");
    await expect(loadReserve(conn, RESERVES.USDC!.replace(/.$/, "1"))).rejects.toThrow();
  }, 60_000);

  it("borrow → repay with nothing in between costs exactly the flash fee; without the fee it fails as a whole", async () => {
    const r = await loadReserve(conn, "USDC");
    const payer = await usdcHolder(r.mint);
    const amount = 10_000n * 10n ** 6n;
    const sim = await simulateFlash(conn, await flashTransaction(conn, { payer, reserve: r, amount, strategy: [] }), { payer, reserve: r });
    console.log("10,000 USDC no-op flash:", sim.ok, sim.error ?? "", "delta", sim.delta, "units", sim.units);
    expect(sim.ok).toBe(true);
    expect(sim.delta!).toBeLessThanOrEqual(0n); // the fee (possibly 0) and nothing else
    expect(-sim.delta!).toBeLessThan(amount / 100n); // under 1%
    // a strategy that loses the money (here: sends the whole balance away) fails at repay, so the
    // whole transaction fails: the loss can't happen, the loan is never kept
    const ata = getAssociatedTokenAddressSync(r.mint, payer, true);
    const held = BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
    const leak = createTransferCheckedInstruction(ata, r.mint, r.feeVault, payer, held + amount, r.decimals);
    const fail = await simulateFlash(conn, await flashTransaction(conn, { payer, reserve: r, amount, strategy: [leak] }), { payer, reserve: r });
    console.log("losing strategy:", fail.error);
    expect(fail.error).toBeDefined();
    const repayFails = await simulateFlash(conn, await flashTransaction(conn, { payer, reserve: r, amount, strategy: [createTransferCheckedInstruction(ata, r.mint, r.feeVault, payer, held + 1n, r.decimals)] }), { payer, reserve: r });
    console.log("short by the fee:", repayFails.error);
    expect(repayFails.ok).toBe(false);
    expect(fail.ok).toBe(false);
  }, 120_000);
});
