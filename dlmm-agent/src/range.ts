/**
 * Range math for single-sided SOL positions. Pure functions, no I/O.
 *
 * A DLMM bin's price is (1 + binStep/10_000)^binId. SOL sits on the side that the token
 * price falls into: below the active bin when SOL is token Y, above it when SOL is token X.
 * "Depth" counts bins away from the entry bin in the direction the token price falls, so
 * both cases share one model: depth 0 = entry bin, depth n = bottom of the range.
 */

/** Bins needed so the range spans a `downsidePct` fall in the token price. */
export function binsForDownside(downsidePct: number, binStep: number, minBins: number, maxBins: number): number {
  const step = Math.log1p(binStep / 10_000);
  const n = Math.ceil(-Math.log(1 - downsidePct / 100) / step);
  return Math.min(maxBins, Math.max(minBins, n));
}

/** Bin ids for a single-sided SOL range of `n` bins below (in token-price terms) the active bin. */
export function solRange(activeId: number, n: number, solIsX: boolean): { minBinId: number; maxBinId: number } {
  return solIsX ? { minBinId: activeId, maxBinId: activeId + n } : { minBinId: activeId - n, maxBinId: activeId };
}

/** How far the active bin has moved into the range, in the token-price-falling direction. */
export function depthOf(entryId: number, activeId: number, solIsX: boolean): number {
  return solIsX ? activeId - entryId : entryId - activeId;
}

export type RangeState = "in" | "above" | "below";

/** "above" = token price rose past the range (all SOL, earning nothing); "below" = fell through it (all token). */
export function rangeState(depth: number, n: number): RangeState {
  if (depth < 0) return "above";
  if (depth > n) return "below";
  return "in";
}

/**
 * Value in SOL of a uniform (spot) single-sided deposit after the price moved to `depth`.
 * Bins the price has crossed were converted to the token at their own price and are marked
 * at the current price; the active bin counts half each.
 */
export function paperValue(depositSol: number, n: number, depth: number, binStep: number): number {
  const per = depositSol / (n + 1);
  const r = 1 + binStep / 10_000;
  let v = 0;
  for (let d = 0; d <= n; d++) {
    const tokenLeg = per * Math.pow(r, d - depth); // SOL → token at bin d, marked at the current price
    if (d < depth) v += tokenLeg;
    else if (d > depth) v += per;
    else v += per / 2 + tokenLeg / 2;
  }
  return v;
}
