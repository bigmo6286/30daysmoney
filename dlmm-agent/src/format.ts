/** Human formatting helpers for Telegram messages. */

/** SOL amount, trailing zeros trimmed; dust below `dp` decimals shows as 0, not -0. */
export function sol(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "?";
  const s = v.toFixed(dp).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

export function signedSol(v: number, dp = 4): string {
  const s = sol(v, dp);
  return v > 0 && s !== "0" ? `+${s}` : s;
}

export function pct(p: number): string {
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function usd(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export function price(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "0";
  if (p >= 1000) return p.toFixed(1);
  if (p >= 0.001) return p.toPrecision(4);
  return p.toExponential(3);
}

export function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
