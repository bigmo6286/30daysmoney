/**
 * Meteora pool discovery API (public, no key). Field names follow the API's snake_case JSON;
 * everything is optional and parsed defensively, because the API is unversioned.
 */
import { logger } from "../log";

const log = logger("disc");
export const WSOL = "So11111111111111111111111111111111111111112";
const BASE = process.env.METEORA_DISCOVERY_URL || "https://pool-discovery-api.datapi.meteora.ag";

export interface Pool {
  address: string;
  name: string;
  /** the non-SOL token */
  mint: string;
  symbol: string;
  /** true when SOL is token X of the pair (the range then sits above the active bin) */
  solIsX: boolean;
  binStep: number;
  tvlUsd: number;
  activeTvlUsd: number;
  volumeUsd: number;
  /** fees earned / active TVL over the timeframe, % */
  feeTvlPct: number;
  volatility: number;
  holders: number;
  mcapUsd: number;
  organic: number;
  launchpad?: string;
  /** ms since epoch */
  createdAt?: number;
  warnings: { critical: boolean; highSingleOwnership: boolean; highConcentration: boolean };
}

type Raw = Record<string, any>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);

export function parsePool(r: Raw): Pool | null {
  const x = r.token_x ?? {};
  const y = r.token_y ?? {};
  if (r.pool_type && r.pool_type !== "dlmm") return null;
  const solIsX = x.address === WSOL;
  if (!solIsX && y.address !== WSOL) return null; // SOL pairs only
  const base = solIsX ? y : x;
  if (!r.pool_address || !base.address) return null;
  return {
    address: String(r.pool_address),
    name: String(r.name ?? `${base.symbol ?? "?"}-SOL`),
    mint: String(base.address),
    symbol: String(base.symbol ?? "?").slice(0, 24),
    solIsX,
    binStep: num(r.dlmm_bin_step),
    tvlUsd: num(r.tvl),
    activeTvlUsd: num(r.active_tvl),
    volumeUsd: num(r.volume),
    feeTvlPct: num(r.fee_active_tvl_ratio),
    volatility: num(r.volatility),
    holders: num(r.base_token_holders),
    mcapUsd: num(base.market_cap ?? r.base_token_market_cap),
    organic: num(base.organic_score ?? r.base_token_organic_score),
    launchpad: base.launchpad ?? r.base_token_launchpad ?? undefined,
    createdAt: num(base.created_at) || undefined,
    warnings: {
      critical: Boolean(r.base_token_has_critical_warnings || r.quote_token_has_critical_warnings),
      highSingleOwnership: Boolean(r.base_token_has_high_single_ownership),
      highConcentration: Boolean(r.base_token_has_high_supply_concentration),
    },
  };
}

export interface DiscoveryQuery {
  timeframe: string;
  minTvlUsd: number;
  minVolumeUsd: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  minHolders: number;
  minBinStep: number;
  maxBinStep: number;
}

/** Server-side pre-filter; the screener re-checks everything locally. */
export function discoveryUrl(q: DiscoveryQuery, pageSize = 50): string {
  const f = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    `tvl>=${q.minTvlUsd}`,
    `volume>=${q.minVolumeUsd}`,
    `base_token_market_cap>=${q.minMcapUsd}`,
    `base_token_market_cap<=${q.maxMcapUsd}`,
    `base_token_holders>=${q.minHolders}`,
    `dlmm_bin_step>=${q.minBinStep}`,
    `dlmm_bin_step<=${q.maxBinStep}`,
  ].join("&&");
  return `${BASE}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(f)}&timeframe=${encodeURIComponent(q.timeframe)}&category=trending`;
}

export async function discover(q: DiscoveryQuery, f: typeof fetch = fetch): Promise<Pool[]> {
  const res = await f(discoveryUrl(q), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`pool discovery HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Raw[] };
  const rows = Array.isArray(body.data) ? body.data : [];
  const pools = rows.map(parsePool).filter((p): p is Pool => p !== null);
  log.debug(`discovery: ${rows.length} rows, ${pools.length} SOL DLMM pools`);
  return pools;
}
