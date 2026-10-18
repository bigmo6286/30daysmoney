/**
 * Live, read-only: a real Jupiter USDC → SOL → USDC round trip inside a Kamino flash loan, built
 * and simulated on mainnet. Liquid routes don't pay, so this checks the safety property: from a
 * wallet holding no USDC, a losing round trip can't complete.
 */
import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadReserve } from "../../src/sol/kamino";
import { Jupiter } from "../../src/sol/jupiter";
import { findRoute, fmtUnits, quoteRoundTrip } from "../../src/sol/arb";

const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const WSOL = "So11111111111111111111111111111111111111112";

/** a system wallet with SOL for fees and no USDC account at all */
async function walletWithoutUsdc(usdc: PublicKey): Promise<PublicKey> {
  const big = await conn.getTokenLargestAccounts(new PublicKey(WSOL));
  for (const a of big.value) {
    const info = (await conn.getParsedAccountInfo(a.address)).value?.data as { parsed?: { info?: { owner?: string } } } | undefined;
    const o = info?.parsed?.info?.owner ? new PublicKey(info.parsed.info.owner) : null;
    if (!o || !PublicKey.isOnCurve(o.toBytes())) continue;
    const [acc, ata] = await conn.getMultipleAccountsInfo([o, getAssociatedTokenAddressSync(usdc, o, true)]);
    if (acc && acc.owner.toBase58() === "11111111111111111111111111111111" && acc.lamports > 50_000_000 && !ata) return o;
  }
  throw new Error("no suitable wallet found");
}

describe("Solana flash round trip (mainnet, simulated)", () => {
  it("quotes, builds and simulates; a losing route fails as a whole from a wallet with no USDC", async () => {
    const r = await loadReserve(conn, "USDC");
    const jup = new Jupiter(process.env.JUPITER_API_KEY || "");
    const amount = 1_000n * 10n ** 6n;
    const fee = amount / 100_000n; // measured on mainnet: 0.001% on the USDC reserve (see kamino.test.ts)
    const trip = await quoteRoundTrip(jup, r.mint.toBase58(), WSOL, amount, fee, 30);
    expect(trip).not.toBeNull();
    console.log(`1,000 USDC → SOL → USDC: ${trip!.buy.route} / ${trip!.sell.route}; expected ${fmtUnits(trip!.expected, 6)} USDC, worst ${fmtUnits(trip!.worst, 6)}`);
    expect(trip!.expected).toBeLessThan(0n); // a liquid pair doesn't pay a round trip

    const payer = await walletWithoutUsdc(r.mint);
    const found = await findRoute(conn, jup, r, payer, WSOL, amount, fee, 30);
    expect(found).not.toBeNull();
    const { built, excluded } = found!;
    console.log(`route ${built.trip.buy.route} / ${built.trip.sell.route} (excluded: ${excluded.join(", ") || "none"}); tx ${built.txSize} bytes, ok=${built.ok}, ${built.error ?? ""}, units ${built.units}`);
    expect(built.txSize).toBeLessThanOrEqual(1232);
    expect(built.ok).toBe(false); // short of loan + fee: klend's repay can't be paid, nothing happens
    expect(built.error).toMatch(/insufficient funds/i);
  }, 180_000);
});
