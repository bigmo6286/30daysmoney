/**
 * Pure range math. Everything is expressed from the user's point of view: the price of the
 * TOKEN in QUOTE (ETH). Pool ticks are token1/token0, so when the quote is token0 the
 * direction flips; these helpers hide that.
 */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const LOG_BASE = Math.log(1.0001);

export type RangeMode = "single" | "inrange";

export interface RangeInput {
  tick: number;
  tickSpacing: number;
  /** true when the quote asset (WETH) is token0 of the pool. */
  quoteIsToken0: boolean;
  widthPct: number;
  singleOffsetPct: number;
}

export interface Range {
  tickLower: number;
  tickUpper: number;
}

const floorTo = (t: number, s: number) => Math.floor(t / s) * s;
const ceilTo = (t: number, s: number) => Math.ceil(t / s) * s;
const clamp = (t: number, s: number) => Math.min(Math.max(t, ceilTo(MIN_TICK, s)), floorTo(MAX_TICK, s)) || 0; // || 0 drops -0

/** Ticks to move for the token price to change by factor f (f > 0). */
const ticksFor = (f: number) => Math.log(f) / LOG_BASE;

/** Pool tick → token price in quote units (decimals-adjusted). */
export function tokenPriceAtTick(tick: number, quoteIsToken0: boolean, dec0: number, dec1: number): number {
  const p = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1); // token1 per token0, human units
  return quoteIsToken0 ? 1 / p : p;
}

/**
 * Convert a token-price interval [lowF, highF] (as factors of the current price) into pool
 * ticks, measured from tick `t`.
 */
function ticksForFactors(t: number, lowF: number, highF: number, quoteIsToken0: boolean): [number, number] {
  // quote is token1 → pool price == token price; quote is token0 → pool price == 1/token price
  return quoteIsToken0 ? [t - ticksFor(highF), t - ticksFor(lowF)] : [t + ticksFor(lowF), t + ticksFor(highF)];
}

/**
 * single  → quote-only position sitting just BELOW the current token price: you provide ETH
 *           and buy the token only if the price dips into the range. Nothing at risk if the
 *           token rugs before reaching it.
 * inrange → straddles the current price (±widthPct). Earns fees immediately, needs both sides.
 */
export function computeRange(mode: RangeMode, r: RangeInput): Range {
  const s = r.tickSpacing;
  const w = r.widthPct / 100;
  if (mode === "inrange") {
    const [a, b] = ticksForFactors(r.tick, Math.max(1 - w, 0.0001), 1 + w, r.quoteIsToken0);
    let lo = clamp(floorTo(a, s), s);
    let hi = clamp(ceilTo(b, s), s);
    // the current tick must be strictly inside [lo, hi)
    if (lo > r.tick) lo = clamp(floorTo(r.tick, s), s);
    if (hi <= r.tick) hi = clamp(floorTo(r.tick, s) + s, s);
    if (hi <= lo) hi = lo + s;
    return { tickLower: lo, tickUpper: hi };
  }
  const off = r.singleOffsetPct / 100;
  const highF = Math.max(1 - off, 0.0001);
  const lowF = Math.max(highF * (1 - w), 0.0001);
  const [a, b] = ticksForFactors(r.tick, lowF, highF, r.quoteIsToken0);
  if (r.quoteIsToken0) {
    // holding only token0 ⇒ the whole range must be ABOVE the current tick
    const lo = clamp(Math.max(ceilTo(a, s), floorTo(r.tick, s) + s), s);
    const hi = clamp(Math.max(ceilTo(b, s), lo + s), s);
    return { tickLower: lo, tickUpper: hi };
  }
  // holding only token1 ⇒ the whole range must be at or BELOW the current tick
  const hi = clamp(Math.min(floorTo(b, s), floorTo(r.tick, s)), s);
  const lo = clamp(Math.min(floorTo(a, s), hi - s), s);
  return { tickLower: lo, tickUpper: hi };
}

export function isInRange(tick: number, r: Range): boolean {
  return tick >= r.tickLower && tick < r.tickUpper;
}

/**
 * Share of the deposit (by value) that has to be converted into the token for an in-range
 * position, given sqrt prices (plain floats are fine for a ratio). 0 = all quote, 1 = all token.
 */
export function tokenShareForRange(tick: number, range: Range, quoteIsToken0: boolean): number {
  if (tick < range.tickLower) return quoteIsToken0 ? 0 : 1; // only token0 needed
  if (tick >= range.tickUpper) return quoteIsToken0 ? 1 : 0; // only token1 needed
  const sp = Math.pow(1.0001, tick / 2);
  const sa = Math.pow(1.0001, range.tickLower / 2);
  const sb = Math.pow(1.0001, range.tickUpper / 2);
  const amt0 = 1 / sp - 1 / sb; // per unit liquidity
  const amt1 = sp - sa;
  const v0 = amt0 * sp * sp; // value in token1 units
  const share0 = v0 / (v0 + amt1);
  return quoteIsToken0 ? 1 - share0 : share0;
}
