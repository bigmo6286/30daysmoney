/** One normalized row per position, whatever produced it. Amounts are in the pair's native unit. */
export type Unit = "ETH" | "SOL";

export interface Row {
  /** who opened it: one of our bots, or a position found in a watched wallet */
  source: "lp-bot" | "dlmm-agent" | "wallet";
  chain: string;
  wallet?: string;
  /** NFT tokenId / position account / paper id */
  id: string;
  pair: string;
  status: "open" | "closed";
  unit: Unit;
  paper?: boolean;
  /** what went in; unknown for wallet positions we didn't open (no cost basis on chain without history) */
  depositNative?: number;
  /** current value incl. unclaimed fees (open) or what came back (closed) */
  valueNative?: number;
  /** unclaimed (open) or total collected (closed) fees */
  feesNative?: number;
  pnlNative?: number;
  pnlPct?: number;
  inRange?: boolean;
  openedAt?: number;
  closedAt?: number;
  note?: string;
  /** bot rows: value the chain can't see (fees already collected, token left in the wallet) */
  extra?: { collectedNative?: number; leftoverRaw?: string; tokenDecimals?: number };
  /** wallet rows: the pair token's price in the native unit, to value `extra.leftoverRaw` */
  tokenPriceNative?: number;
}

export interface UnitTotals {
  openValue: number;
  unclaimedFees: number;
  /** open positions with a known cost basis: value − deposit */
  unrealized: number;
  realized: number;
  closed: number;
  wins: number;
}

export interface Summary {
  at: number;
  rows: Row[];
  totals: Record<Unit, UnitTotals>;
  /** realized PnL per UTC day per unit */
  daily: { day: string; unit: Unit; pnl: number; count: number }[];
  warnings: string[];
}

const empty = (): UnitTotals => ({ openValue: 0, unclaimedFees: 0, unrealized: 0, realized: 0, closed: 0, wins: 0 });

export function summarize(rows: Row[], warnings: string[] = [], at = Date.now()): Summary {
  const totals: Record<Unit, UnitTotals> = { ETH: empty(), SOL: empty() };
  const daily = new Map<string, { day: string; unit: Unit; pnl: number; count: number }>();
  for (const r of rows) {
    const t = totals[r.unit];
    if (r.status === "open") {
      t.openValue += r.valueNative ?? 0;
      t.unclaimedFees += r.feesNative ?? 0;
      if (r.valueNative !== undefined && r.depositNative !== undefined) t.unrealized += r.valueNative - r.depositNative;
    } else if (r.pnlNative !== undefined) {
      t.realized += r.pnlNative;
      t.closed += 1;
      if (r.pnlNative > 0) t.wins += 1;
      const day = new Date(r.closedAt ?? at).toISOString().slice(0, 10);
      const k = `${day}|${r.unit}`;
      const d = daily.get(k) ?? { day, unit: r.unit, pnl: 0, count: 0 };
      d.pnl += r.pnlNative;
      d.count += 1;
      daily.set(k, d);
    }
  }
  return { at, rows, totals, daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)), warnings };
}

const csvCell = (v: unknown) => {
  const s = v === undefined ? "" : String(v);
  // neutralise spreadsheet formulas (CSV injection) and quote when needed
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows: Row[]): string {
  const cols: (keyof Row)[] = ["source", "chain", "wallet", "id", "pair", "status", "unit", "paper", "depositNative", "valueNative", "feesNative", "pnlNative", "pnlPct", "inRange", "openedAt", "closedAt", "note"];
  const iso = (k: keyof Row, v: unknown) => ((k === "openedAt" || k === "closedAt") && typeof v === "number" ? new Date(v).toISOString() : v);
  return [cols.join(","), ...rows.map((r) => cols.map((k) => csvCell(iso(k, r[k]))).join(","))].join("\n") + "\n";
}
