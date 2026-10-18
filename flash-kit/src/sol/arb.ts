/**
 * Flash-loan round trip on Solana: borrow the loan token from Kamino, swap it into `mid` and back
 * through Jupiter, repay. Quotes first; only a route whose quoted return beats the loan + fee +
 * your floor is built, and every built route is simulated before anything could be sent.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { flashTransaction, simulateFlash, type Reserve, type SimResult } from "./kamino";
import type { Jupiter, JupQuote } from "./jupiter";

export interface RoundTrip {
  amount: bigint;
  buy: JupQuote;
  sell: JupQuote;
  /** quoted return − amount − fee (raw units); what the round trip would make at the quotes */
  expected: bigint;
  /** the same at worst-case slippage */
  worst: bigint;
}

export async function quoteRoundTrip(jup: Jupiter, loanMint: string, mid: string, amount: bigint, fee: bigint, slippageBps: number, excludeDexes: string[] = []): Promise<RoundTrip | null> {
  const buy = await jup.quote(loanMint, mid, amount, slippageBps, excludeDexes);
  if (!buy) return null;
  // the sell leg spends what the buy leg is guaranteed to return, so it can't run short
  const sell = await jup.quote(mid, loanMint, buy.minOut, slippageBps, excludeDexes);
  if (!sell) return null;
  return { amount, buy, sell, expected: sell.outAmount - amount - fee, worst: sell.minOut - amount - fee };
}

export interface Built extends SimResult {
  trip: RoundTrip;
  txSize: number;
}

/** Build the whole flash transaction for a round trip and simulate it as the payer. */
export async function buildAndSimulate(conn: Connection, jup: Jupiter, r: Reserve, payer: PublicKey, trip: RoundTrip, priorityMicroLamports = 0) {
  const a = await jup.instructions(conn, trip.buy, payer);
  const b = await jup.instructions(conn, trip.sell, payer);
  const plan = { payer, reserve: r, amount: trip.amount, strategy: [...a.instructions, ...b.instructions], lookupTables: [...a.lookupTables, ...b.lookupTables], priorityMicroLamports };
  const tx = await flashTransaction(conn, plan);
  let size: number;
  try {
    size = tx.serialize().length;
  } catch {
    throw new Error("the route is too large for one transaction; try a smaller --max-accounts or another token");
  }
  const sim = await simulateFlash(conn, tx, plan);
  return { tx, built: { ...sim, trip, txSize: size } as Built };
}

/** klend's own failure (the repay couldn't be paid) vs. a swap venue refusing or failing */
export const repayFailed = (b: Pick<Built, "logs" | "error">) => /insufficient funds/i.test(b.error ?? "") || b.logs.some((l) => /FlashRepay/i.test(l) && /failed|insufficient/i.test(l));

/**
 * Quote → build → simulate, re-quoting without a venue whenever a swap leg fails inside the flash
 * transaction (some market makers refuse to trade next to other programs). Up to `tries` routes.
 */
export async function findRoute(conn: Connection, jup: Jupiter, r: Reserve, payer: PublicKey, mid: string, amount: bigint, fee: bigint, slippageBps: number, tries = 4) {
  const excluded: string[] = [];
  let last: Awaited<ReturnType<typeof buildAndSimulate>> | null = null;
  for (let i = 0; i < tries; i++) {
    const trip = await quoteRoundTrip(jup, r.mint.toBase58(), mid, amount, fee, slippageBps, excluded);
    if (!trip) break;
    last = await buildAndSimulate(conn, jup, r, payer, trip);
    if (last.built.ok || repayFailed(last.built)) return { ...last, excluded };
    excluded.push(...trip.buy.labels, ...trip.sell.labels);
  }
  return last ? { ...last, excluded } : null;
}

export const fmtUnits = (raw: bigint, decimals: number) => {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const s = (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });
  return `${neg ? "−" : ""}${s}`;
};
