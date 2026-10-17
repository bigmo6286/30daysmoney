/** Exit rules. Pure: the agent feeds a snapshot, gets back a reason to close or null. */
import type { Settings } from "./config";
import type { RangeState } from "./range";

export interface ExitSnapshot {
  ageMin: number;
  pnlPct: number;
  peakPnlPct: number;
  range: RangeState;
  /** minutes the position has been in its current out-of-range state; 0 when in range */
  oorMin: number;
  /** latest pool fee / active TVL (%) over the screening timeframe; undefined = unknown */
  feeTvlPct?: number;
}

export type ExitRules = Pick<
  Settings,
  | "stopLossPct"
  | "takeProfitPct"
  | "trailArmPct"
  | "trailDropPct"
  | "minAgeMin"
  | "oorAboveMin"
  | "oorBelowMin"
  | "minFeeTvlPctHold"
  | "lowYieldAfterMin"
>;

export function exitReason(s: ExitSnapshot, r: ExitRules): string | null {
  // the stop loss is never gated: a rug at −90% must still be cut
  if (r.stopLossPct > 0 && s.pnlPct <= -r.stopLossPct) return `stop loss ${s.pnlPct.toFixed(1)}%`;
  if (s.ageMin < r.minAgeMin) return null;
  if (r.takeProfitPct > 0 && s.pnlPct >= r.takeProfitPct) return `take profit +${s.pnlPct.toFixed(1)}%`;
  if (r.trailArmPct > 0 && s.peakPnlPct >= r.trailArmPct && s.peakPnlPct - s.pnlPct >= r.trailDropPct) {
    return `trailing TP: +${s.pnlPct.toFixed(1)}% (peak +${s.peakPnlPct.toFixed(1)}%)`;
  }
  if (s.range === "above" && s.oorMin >= r.oorAboveMin) return `price above range ${Math.round(s.oorMin)}m`;
  if (s.range === "below" && s.oorMin >= r.oorBelowMin) return `price below range ${Math.round(s.oorMin)}m`;
  if (r.minFeeTvlPctHold > 0 && s.ageMin >= r.lowYieldAfterMin && s.feeTvlPct !== undefined && s.feeTvlPct < r.minFeeTvlPctHold) {
    return `yield faded (${s.feeTvlPct.toFixed(2)}% fee/TVL)`;
  }
  return null;
}
