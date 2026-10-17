/**
 * Pro history: each refresh records the totals per unit, kept in the browser (localStorage) so
 * nothing about the wallets leaves the device. Readings are bucketed by hour, kept for 180 days.
 */
import type { Summary, Unit } from "../src/model";

export interface Snapshot {
  /** start of the hour, ms */
  t: number;
  unit: Unit;
  value: number;
  fees: number;
  positions: number;
}

const HOUR = 3_600_000;
const KEEP_MS = 180 * 24 * HOUR;

export function record(history: Snapshot[], s: Summary): Snapshot[] {
  const t = Math.floor(s.at / HOUR) * HOUR;
  const next = history.filter((h) => h.t !== t && h.t > s.at - KEEP_MS); // the newest reading in an hour wins
  for (const unit of ["ETH", "SOL", "USD"] as Unit[]) {
    const open = s.rows.filter((r) => r.unit === unit && r.status === "open" && r.valueNative !== undefined);
    if (!open.length) continue;
    next.push({ t, unit, value: s.totals[unit].openValue, fees: s.totals[unit].unclaimedFees, positions: open.length });
  }
  return next.sort((a, b) => a.t - b.t);
}

/** One reading per UTC day per unit (the last of the day), for the trend table and chart. */
export function daily(history: Snapshot[]): Snapshot[] {
  const by = new Map<string, Snapshot>();
  for (const h of history) by.set(`${new Date(h.t).toISOString().slice(0, 10)}|${h.unit}`, h);
  return [...by.values()].sort((a, b) => a.t - b.t);
}

export function historyCsv(history: Snapshot[]): string {
  return ["time,unit,value,unclaimed_fees,positions", ...history.map((h) => `${new Date(h.t).toISOString()},${h.unit},${h.value},${h.fees},${h.positions}`)].join("\n") + "\n";
}

/**
 * A reading goes into history unless a source that failed this time has held positions before:
 * then its value is missing and the total would show a drop that didn't happen. (A chain the
 * wallet never used can fail without harm, e.g. one RPC being down.) `before` is the last
 * successful position count per wallet|source.
 */
export function trustworthy(s: { failed: string[]; rows: unknown[] }, before: Record<string, number>): boolean {
  return s.rows.length > 0 && s.failed.every((k) => !before[k]);
}
