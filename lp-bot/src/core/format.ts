/** Human formatting helpers for Telegram messages. */

/** wei → "0.0123" with up to `dp` decimals, trailing zeros trimmed. */
export function eth(wei: bigint, dp = 5): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  const body = `${whole}${frac ? "." + frac : ""}`;
  return neg && body !== "0" ? `-${body}` : body; // dust below `dp` decimals shows as 0, not -0
}

export function signedEth(wei: bigint, dp = 5): string {
  return `${wei > 0n ? "+" : ""}${eth(wei, dp)}`;
}

/** Compact price: 0.000001234 → "1.234e-6", 1234.5 → "1234.5". */
export function price(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "0";
  if (p >= 1000) return p.toFixed(1);
  if (p >= 0.001) return p.toPrecision(4);
  return p.toExponential(3);
}

export function pct(p: number): string {
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

export function feeTier(fee: number): string {
  return `${(fee / 10_000).toString()}%`;
}

export function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
