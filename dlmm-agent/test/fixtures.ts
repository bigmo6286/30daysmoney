import { WSOL } from "../src/auto/discovery";

/** A discovery API row, shaped like the live API's (SOL as token Y unless flipped). */
export function rawPool(over: Record<string, unknown> = {}, sym = "FROG", mint = "Frog111111111111111111111111111111111111111", solIsX = false) {
  const tok = { address: mint, symbol: sym, market_cap: 2_000_000, organic_score: 80, created_at: Date.now() - 48 * 3_600_000 };
  const s = { address: WSOL, symbol: "SOL", organic_score: 99 };
  return {
    pool_address: `Pool${sym}${solIsX ? "X" : "Y"}`,
    name: `${sym}-SOL`,
    pool_type: "dlmm",
    tvl: 50_000,
    active_tvl: 30_000,
    volume: 200_000,
    fee: 40,
    fee_active_tvl_ratio: 1.5,
    volatility: 3,
    base_token_holders: 4_000,
    base_token_has_critical_warnings: false,
    base_token_has_high_single_ownership: false,
    dlmm_params: { bin_step: 100, collect_fee_mode: "both" },
    token_x: solIsX ? s : tok,
    token_y: solIsX ? tok : s,
    ...over,
  };
}
