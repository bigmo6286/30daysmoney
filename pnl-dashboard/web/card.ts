/**
 * The share card: a 1200×630 image of the current positions for X / Telegram, with a link back to
 * the dashboard. Never shows wallet addresses; amounts are optional (some people only want to
 * show pairs and range).
 */
import type { Summary, Unit } from "../src/model";

export interface CardModel {
  headline: string;
  sub: string;
  stats: { k: string; v: string }[];
  pairs: { pair: string; chain: string; inRange?: boolean }[];
  more: number;
}

const UNITS: Unit[] = ["USD", "ETH", "SOL"];
const MAX_PAIRS = 5;

const fmt = (v: number, unit: Unit) =>
  unit === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 })}` : `${(+v.toFixed(unit === "ETH" ? 4 : 3)).toString()} ${unit}`;

export function cardModel(s: Summary, showAmounts: boolean): CardModel {
  const open = s.rows.filter((r) => r.status === "open");
  const inRange = open.filter((r) => r.inRange).length;
  const chains = [...new Set(open.map((r) => r.chain))];
  const units = UNITS.filter((u) => open.some((r) => r.unit === u && r.valueNative !== undefined));
  const stats: CardModel["stats"] = [];
  if (showAmounts) for (const u of units) stats.push({ k: `${u === "USD" ? "Stablecoin pairs" : `${u} pairs`}`, v: `${fmt(s.totals[u].openValue, u)} · ${fmt(s.totals[u].unclaimedFees, u)} fees` });
  stats.push({ k: "In range", v: `${inRange} of ${open.length}` });
  const sorted = [...open].sort((a, b) => Number(!!b.inRange) - Number(!!a.inRange) || (b.valueNative ?? -1) - (a.valueNative ?? -1));
  const main = units[0];
  return {
    headline: showAmounts && main ? `${fmt(s.totals[main].unclaimedFees, main)} in unclaimed fees` : `${open.length} LP position${open.length === 1 ? "" : "s"}, ${inRange} in range`,
    sub: chains.length ? `across ${chains.join(", ")}` : "",
    stats,
    pairs: sorted.slice(0, MAX_PAIRS).map((r) => ({ pair: r.pair, chain: r.chain, inRange: r.inRange })),
    more: Math.max(0, open.length - MAX_PAIRS),
  };
}

// fixed colors: the image looks the same wherever it's posted
const C = { bg: "#0f1218", panel: "#171c25", line: "#283040", ink: "#eef1f6", ink2: "#b8c0cc", muted: "#8590a0", accent: "#6f98ff", ok: "#4cc38a", off: "#e66767" };

export function drawCard(m: CardModel, link: string, scale = 1): HTMLCanvasElement {
  const W = 1200, H = 630;
  const cv = document.createElement("canvas");
  cv.width = W * scale;
  cv.height = H * scale;
  const g = cv.getContext("2d")!;
  g.scale(scale, scale);
  const font = (px: number, w = 400) => `${w} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const fit = (t: string, px: number, w: number, max: number) => {
    g.font = font(px, w);
    let s = t;
    while (g.measureText(s).width > max && s.length > 1) s = s.slice(0, -2) + "…";
    return s;
  };
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = C.accent;
  g.fillRect(0, 0, W, 6);

  g.fillStyle = C.muted;
  g.font = font(24, 600);
  g.fillText("MY LP POSITIONS", 64, 84);
  g.fillStyle = C.ink;
  g.fillText(fit(m.headline, 58, 700, W - 128), 64, 160);
  g.fillStyle = C.ink2;
  g.fillText(fit(m.sub, 26, 400, W - 128), 64, 204);

  // left: stats; right: pairs
  let y = 270;
  for (const st of m.stats.slice(0, 4)) {
    g.fillStyle = C.muted;
    g.fillText(fit(st.k, 20, 500, 470), 64, y);
    g.fillStyle = C.ink;
    g.fillText(fit(st.v, 30, 650, 470), 64, y + 38);
    y += 82;
  }

  const px = 600, pw = 536;
  g.fillStyle = C.panel;
  g.strokeStyle = C.line;
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(px, 244, pw, 300, 16);
  g.fill();
  g.stroke();
  let py = 292;
  for (const p of m.pairs) {
    g.fillStyle = p.inRange === undefined ? C.muted : p.inRange ? C.ok : C.off;
    g.beginPath();
    g.arc(px + 30, py - 8, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.ink;
    g.fillText(fit(p.pair, 24, 600, 300), px + 50, py);
    g.fillStyle = C.muted;
    g.textAlign = "right";
    g.fillText(fit(p.chain, 20, 400, 170), px + pw - 24, py);
    g.textAlign = "left";
    py += 50;
  }
  if (m.more) {
    g.fillStyle = C.muted;
    g.fillText(`+ ${m.more} more`, px + 50, py);
  }

  g.fillStyle = C.ink2;
  g.fillText("Tracked free with LP PnL: Uniswap v3/v4 + Meteora, read-only", 64, 590);
  g.fillStyle = C.accent;
  g.textAlign = "right";
  g.fillText(fit(link.replace(/^https?:\/\//, "").replace(/\?.*$/, ""), 20, 600, 420), W - 64, 590);
  g.textAlign = "left";
  return cv;
}
