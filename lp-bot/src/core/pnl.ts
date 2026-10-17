/** Pure PnL math. All amounts are raw bigint in the units noted. */

export interface PnlInput {
  /** quote (WETH wei) put into the position at open, including the part swapped to the token */
  depositQuote: bigint;
  /** token amounts that went into the position at open (raw) */
  depositToken: bigint;
  depositQuoteInPosition: bigint;
  /** current principal in the position */
  nowToken: bigint;
  nowQuote: bigint;
  /** uncollected (or, in paper mode, estimated) fees */
  feeToken: bigint;
  feeQuote: bigint;
  /** quote per 1 whole token, scaled by 1e18 (current pool price) */
  priceQuotePerTokenE18: bigint;
  tokenDecimals: number;
}

export interface Pnl {
  valueQuote: bigint; // principal + fees, valued in quote
  feesQuote: bigint;
  pnlQuote: bigint; // vs deposit
  pnlPct: number;
  hodlQuote: bigint; // what the deposited amounts would be worth now if just held
  vsHodlQuote: bigint; // LP result vs holding: fees − impermanent loss
}

export function tokenToQuote(amount: bigint, priceE18: bigint, decimals: number): bigint {
  return (amount * priceE18) / 10n ** BigInt(decimals);
}

export function computePnl(p: PnlInput): Pnl {
  const toQ = (a: bigint) => tokenToQuote(a, p.priceQuotePerTokenE18, p.tokenDecimals);
  const feesQuote = p.feeQuote + toQ(p.feeToken);
  const valueQuote = p.nowQuote + toQ(p.nowToken) + feesQuote;
  const pnlQuote = valueQuote - p.depositQuote;
  const hodlQuote = p.depositQuoteInPosition + toQ(p.depositToken);
  const pnlPct = p.depositQuote > 0n ? Number((pnlQuote * 1_000_000n) / p.depositQuote) / 10_000 : 0;
  return { valueQuote, feesQuote, pnlQuote, pnlPct, hodlQuote, vsHodlQuote: valueQuote - hodlQuote };
}

/** sqrtPriceX96 → quote per whole token × 1e18. */
export function priceE18FromSqrt(sqrtPriceX96: bigint, quoteIsToken0: boolean, tokenDecimals: number, quoteDecimals = 18): bigint {
  const Q192 = 1n << 192n;
  const num = sqrtPriceX96 * sqrtPriceX96; // token1/token0 (raw) × 2^192
  const scale = 10n ** 18n * 10n ** BigInt(tokenDecimals);
  const qd = 10n ** BigInt(quoteDecimals);
  // raw price r = token1raw/token0raw. quote per whole token (in quote raw) then rescaled to 1e18.
  if (!quoteIsToken0) return (num * scale) / Q192 / qd; // token0 = token, token1 = quote
  if (num === 0n) return 0n;
  return (Q192 * scale) / num / qd; // token1 = token, token0 = quote
}

/** Fee growth accrued by `liquidity` between two global fee-growth readings (X128). */
export function feesFromGrowth(liquidity: bigint, growthBefore: bigint, growthAfter: bigint): bigint {
  const MOD = 1n << 256n;
  const delta = (((growthAfter - growthBefore) % MOD) + MOD) % MOD; // fee growth wraps by design
  return (liquidity * delta) >> 128n;
}
