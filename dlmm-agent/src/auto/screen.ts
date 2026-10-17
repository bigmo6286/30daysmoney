/**
 * Deterministic pool screening: every threshold is a setting, every rejection has a reason.
 * Ranking is by fee yield (fees / active TVL), scaled by Meteora's organic-activity score,
 * halved when another pool trades the same symbol (a likely copy/"PVP" launch).
 */
import type { Settings } from "../config";
import type { Pool } from "./discovery";

export interface Ranked {
  pool: Pool;
  score: number;
  /** symbol also traded by another pool in the same listing */
  pvp: boolean;
}

export interface Rejected {
  pool: Pool;
  reason: string;
}

export function rejectReason(p: Pool, s: Settings, now = Date.now()): string | null {
  if (p.warnings.critical) return "critical token warning";
  if (p.warnings.highSingleOwnership) return "single wallet holds too much";
  if (p.tvlUsd < s.minTvlUsd) return `TVL ${Math.round(p.tvlUsd)} < ${s.minTvlUsd}`;
  if (p.volumeUsd < s.minVolumeUsd) return `volume ${Math.round(p.volumeUsd)} < ${s.minVolumeUsd}`;
  if (p.feeTvlPct < s.minFeeTvlPct) return `fee/TVL ${p.feeTvlPct.toFixed(2)}% < ${s.minFeeTvlPct}%`;
  if (p.mcapUsd < s.minMcapUsd || p.mcapUsd > s.maxMcapUsd) return `mcap ${Math.round(p.mcapUsd)} outside range`;
  if (p.holders < s.minHolders) return `${p.holders} holders < ${s.minHolders}`;
  if (p.organic < s.minOrganic) return `organic ${p.organic.toFixed(0)} < ${s.minOrganic}`;
  if (p.binStep < s.minBinStep || p.binStep > s.maxBinStep) return `bin step ${p.binStep} outside ${s.minBinStep}-${s.maxBinStep}`;
  if (p.volatility <= 0) return "no volatility data";
  if (s.minTokenAgeHours > 0) {
    if (!p.createdAt) return "token age unknown";
    if (now - p.createdAt < s.minTokenAgeHours * 3_600_000) return `token younger than ${s.minTokenAgeHours}h`;
  }
  return null;
}

export function rank(pools: Pool[], s: Settings, now = Date.now()): { ranked: Ranked[]; rejected: Rejected[] } {
  const bySymbol = new Map<string, Set<string>>();
  for (const p of pools) {
    const k = p.symbol.toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, new Set());
    bySymbol.get(k)!.add(p.mint);
  }
  const ranked: Ranked[] = [];
  const rejected: Rejected[] = [];
  const seenMint = new Set<string>();
  // best pool per token only: sort by yield first so the first one kept is the best
  for (const p of [...pools].sort((a, b) => b.feeTvlPct - a.feeTvlPct)) {
    const reason = rejectReason(p, s, now);
    if (reason) {
      rejected.push({ pool: p, reason });
      continue;
    }
    if (seenMint.has(p.mint)) continue;
    seenMint.add(p.mint);
    const pvp = (bySymbol.get(p.symbol.toUpperCase())?.size ?? 0) > 1;
    ranked.push({ pool: p, pvp, score: p.feeTvlPct * (p.organic / 100) * (pvp ? 0.5 : 1) });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, rejected };
}
