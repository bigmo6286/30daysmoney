/**
 * Flash-loan round trip on Solana: borrow the loan token from Kamino, swap it into `mid` and back
 * through Jupiter, repay. Quotes first; only a route whose quoted return beats the loan + fee +
 * your floor is built, and every built route is simulated before anything could be sent.
 */
import { PACKET_DATA_SIZE, type Connection, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { FLASH_BORROW_INDEX, flashTransaction, simulateFlash, type Reserve, type SimResult } from "./kamino";
import type { Jupiter, JupQuote, SwapIxs } from "./jupiter";

export interface RoundTrip {
  amount: bigint;
  buy: JupQuote;
  sell: JupQuote;
  /** quoted return − amount − fee (raw units); what the round trip would make at the quotes */
  expected: bigint;
  /** the same at worst-case slippage */
  worst: bigint;
}

/**
 * Account caps per swap leg, largest first. Each leg is capped at the first; when the two legs plus
 * the flash loan don't fit in one transaction, the route is re-quoted at the next, smaller cap
 * (fewer hops, maybe a little less profit) instead of being dropped.
 */
export const MAX_ACCOUNTS = [24, 16, 12] as const;

export class RouteTooLargeError extends Error {
  constructor() {
    super("the route is too large for one transaction; try a smaller --max-accounts or another token");
  }
}

/** what the sell leg holds back from the quoted buy amount, in basis points */
export const SELL_BUFFER_BPS = 3n;

export async function quoteRoundTrip(jup: Jupiter, loanMint: string, mid: string, amount: bigint, fee: bigint, slippageBps: number, excludeDexes: string[] = [], maxAccounts: number = MAX_ACCOUNTS[0]): Promise<RoundTrip | null> {
  const buy = await jup.quote(loanMint, mid, amount, slippageBps, excludeDexes, maxAccounts);
  if (!buy) return null;
  // the sell leg is priced on what the buy leg is quoted to return, less a tiny buffer. (It used to
  // be priced on the slippage floor, `minOut`, which made every round trip look ~0.3% worse than it
  // is, so no gap was ever seen.) This is only the estimate: the built transaction sells exactly
  // what the buy delivers (Jupiter's token ledger, see `roundTripStrategy`).
  const sell = await jup.quote(mid, loanMint, buy.outAmount - (buy.outAmount * SELL_BUFFER_BPS) / 10_000n, slippageBps, excludeDexes, maxAccounts);
  if (!sell) return null;
  return { amount, buy, sell, expected: sell.outAmount - amount - fee, worst: sell.minOut - amount - fee };
}

export interface Built extends SimResult {
  trip: RoundTrip;
  txSize: number;
  /** on failure: which step failed */
  stage?: Stage;
}

export type Stage = "setup" | "borrow" | "buy" | "sell" | "repay";

/**
 * Which step an instruction index belongs to, in a flash transaction laid out as: setup ixs, the
 * borrow at `borrowIndex`, `buyLen` buy-side ixs (setup, ledger, swap, cleanup), the sell-side ixs,
 * then the repay as the last of `total`.
 */
export function stageOf(ix: number, borrowIndex: number, buyLen: number, total: number): Stage {
  if (ix < borrowIndex) return "setup";
  if (ix === borrowIndex) return "borrow";
  if (ix >= total - 1) return "repay";
  return ix <= borrowIndex + buyLen ? "buy" : "sell";
}

/** A failed simulation in a few words: which step, and at the repay how far short the swaps came back. */
export function failureNote(b: Pick<Built, "error" | "stage" | "returned" | "trip">, fee: bigint, toUnits: (raw: bigint) => string): string {
  const where = b.stage ? ` at ${b.stage}` : "";
  if (b.stage === "repay" && b.returned !== undefined) {
    const net = b.returned - b.trip.amount - fee;
    return `failed${where}: swaps returned ${toUnits(b.returned)} of ${toUnits(b.trip.amount + fee)} owed (${net >= 0n ? "+" : "−"}${toUnits(net < 0n ? -net : net)})`;
  }
  return `failed${where}: ${b.error ?? "unknown error"}`;
}

/**
 * The two swaps in order, with the sell spending exactly what the buy delivered. A fixed-size sell
 * failed ("insufficient funds") whenever the buy filled even a few bps under its quote, which live
 * simulations showed it does by 3–17 bps, so nearly every candidate died before its profit was
 * checked. The sell's token-ledger instruction records the mid-token balance after the buy's setup
 * (which creates that token account) and before the buy's swap; the sell then spends the difference.
 */
export function roundTripStrategy(buy: SwapIxs, sell: SwapIxs): TransactionInstruction[] {
  if (!sell.tokenLedger) throw new Error("the sell leg needs a token ledger instruction");
  return [...buy.setup, sell.tokenLedger, buy.swap, ...buy.cleanup, ...sell.setup, sell.swap, ...sell.cleanup];
}

/** Build the whole flash transaction for a round trip and simulate it as the payer. */
/** `opts`: a priority fee (micro-lamports per CU) and/or a compute-unit limit for the flash transaction */
export async function buildAndSimulate(conn: Connection, jup: Jupiter, r: Reserve, payer: PublicKey, trip: RoundTrip, opts: number | { priorityMicroLamports?: number; computeUnits?: number } = 0) {
  const o = typeof opts === "number" ? { priorityMicroLamports: opts } : opts;
  const a = await jup.instructions(conn, trip.buy, payer);
  const b = await jup.instructions(conn, trip.sell, payer, { tokenLedger: true });
  const plan = { payer, reserve: r, amount: trip.amount, strategy: roundTripStrategy(a, b), lookupTables: [...a.lookupTables, ...b.lookupTables], priorityMicroLamports: o.priorityMicroLamports ?? 0, computeUnits: o.computeUnits };
  const tx = await flashTransaction(conn, plan);
  let size: number;
  try {
    size = tx.serialize().length;
  } catch {
    throw new RouteTooLargeError();
  }
  // serialize() can succeed past Solana's packet limit; the RPC then refuses it ("too large: 1696
  // bytes (max: encoded/raw 1644/1232)"), which used to skip the smaller-cap retry
  if (size > PACKET_DATA_SIZE) throw new RouteTooLargeError();
  const sim = await simulateFlash(conn, tx, plan);
  const buyLen = a.setup.length + 1 + 1 + a.cleanup.length; // setup, the sell's ledger, swap, cleanup
  const stage = sim.failedIx !== undefined ? stageOf(sim.failedIx, FLASH_BORROW_INDEX, buyLen, tx.message.compiledInstructions.length) : undefined;
  return { tx, built: { ...sim, trip, txSize: size, ...(stage ? { stage } : {}) } as Built };
}

/** klend's own failure (the repay couldn't be paid) vs. a swap venue refusing or failing */
export const repayFailed = (b: Pick<Built, "logs" | "error">) => /insufficient funds/i.test(b.error ?? "") || b.logs.some((l) => /FlashRepay/i.test(l) && /failed|insufficient/i.test(l));

/**
 * Quote → build → simulate, re-quoting without a venue whenever a swap leg fails inside the flash
 * transaction (some market makers refuse to trade next to other programs), and with a smaller
 * account cap whenever the route doesn't fit in one transaction. Up to `tries` venue retries.
 */
export async function findRoute(conn: Connection, jup: Jupiter, r: Reserve, payer: PublicKey, mid: string, amount: bigint, fee: bigint, slippageBps: number, tries = 4, build: typeof buildAndSimulate = buildAndSimulate) {
  const excluded: string[] = [];
  let last: Awaited<ReturnType<typeof buildAndSimulate>> | null = null;
  let cap = 0;
  for (let i = 0; i < tries; ) {
    const trip = await quoteRoundTrip(jup, r.mint.toBase58(), mid, amount, fee, slippageBps, excluded, MAX_ACCOUNTS[cap]!);
    if (!trip) break;
    try {
      last = await build(conn, jup, r, payer, trip);
    } catch (e) {
      // too big at this cap: try a smaller one (doesn't use up a venue retry); out of caps, give up
      if (e instanceof RouteTooLargeError && cap + 1 < MAX_ACCOUNTS.length) {
        cap++;
        continue;
      }
      throw e;
    }
    if (last.built.ok || repayFailed(last.built)) return { ...last, excluded, maxAccounts: MAX_ACCOUNTS[cap]! as number };
    excluded.push(...trip.buy.labels, ...trip.sell.labels);
    i++;
  }
  return last ? { ...last, excluded, maxAccounts: MAX_ACCOUNTS[cap]! as number } : null;
}

export const fmtUnits = (raw: bigint, decimals: number) => {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const s = (Number(v) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals });
  return `${neg ? "−" : ""}${s}`;
};
