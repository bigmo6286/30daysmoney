/**
 * The browser dashboard: wallets and settings live in localStorage, data comes straight from the
 * chains (load.ts), Pro is a license key checked offline (license.ts). No server sees anything.
 */
import { checkLicense, type Check } from "./license";
import { kindOf, loadAll, type Wallet } from "./load";
import { daily, historyCsv, record, trustworthy, type Snapshot } from "./history";
import { toCsv, type Row, type Summary, type Unit } from "../src/model";
import { cardModel, drawCard } from "./card";

const FREE_WALLETS = 1;
const PRO_WALLETS = 20;
const AUTO_REFRESH_MS = 2 * 60_000;
const STORE = new URL("../", location.href).href;

// ── storage (wrapped: private windows and blocked storage must not break the page) ──
const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(`pnl.${k}`);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`pnl.${k}`, JSON.stringify(v));
    } catch {
      /* unavailable: the session still works */
    }
  },
};

let wallets = store.get<Wallet[]>("wallets", []);
let solanaRpc = store.get<string>("solanaRpc", "");
let licenseKey = store.get<string>("license", "");
let history = store.get<Snapshot[]>("history", []);
/** positions last seen per wallet|source: a failed read only spoils a reading if it had some */
let seen = store.get<Record<string, number>>("seen", {});
let plan: Check = checkLicense(licenseKey);
let last: Summary | null = null;
let timer: number | undefined;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (v: number | undefined, dp = 4) => (v === undefined || Number.isNaN(v) ? "–" : (+v).toFixed(dp).replace(/\.?0+$/, "") || "0");
const money = (v: number | undefined, unit: Unit) => (v === undefined ? "–" : unit === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `${num(v, unit === "ETH" ? 4 : 3)} ${unit}`);
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
const cap = () => (plan.pro ? PRO_WALLETS : FREE_WALLETS);

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── plan badge, wallets, settings ──
function renderPlan() {
  const b = $("plan");
  if (plan.pro) {
    const e = plan.license.expires;
    b.textContent = e ? `Pro · until ${new Date(e).toISOString().slice(0, 10)}` : "Pro";
    b.className = "badge pro";
  } else {
    b.textContent = "Free";
    b.className = "badge";
  }
  $("license-status").textContent = plan.pro ? `Active: ${plan.license.product}, order ${plan.license.order}` : licenseKey ? `Not active: ${plan.reason}` : "No key: free plan (1 wallet).";
  $("csv").toggleAttribute("disabled", !plan.pro);
  $("csv").title = plan.pro ? "" : "Pro feature";
  for (const el of document.querySelectorAll<HTMLElement>("[data-pro-only]")) el.hidden = plan.pro;
  for (const el of document.querySelectorAll<HTMLElement>("[data-pro]")) el.hidden = !plan.pro;
  clearInterval(timer);
  if (plan.pro) timer = window.setInterval(() => void refresh(), AUTO_REFRESH_MS);
}

function renderWallets() {
  $("wallets").innerHTML = wallets
    .map((w, i) => `<span class="chip" title="${esc(w.address)}">${esc(w.label || short(w.address))}<button aria-label="Remove ${esc(w.address)}" data-rm="${i}">×</button></span>`)
    .join("");
  const full = wallets.length >= cap();
  $<HTMLInputElement>("addr").disabled = full;
  $<HTMLButtonElement>("add").disabled = full;
  $("cap").innerHTML = full && !plan.pro
    ? `Free tracks one wallet. <a href="${STORE}?ref=dashboard">Pro</a> tracks up to ${PRO_WALLETS}, keeps history and exports CSV.`
    : `${wallets.length} of ${cap()} wallets`;
  $("empty").hidden = wallets.length > 0;
}

$("wallets").addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).dataset.rm;
  if (i === undefined) return;
  wallets.splice(Number(i), 1);
  store.set("wallets", wallets);
  renderWallets();
  void refresh();
});

$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("addr");
  const label = $<HTMLInputElement>("label");
  const a = input.value.trim();
  const err = $("add-err");
  if (!kindOf(a)) return void (err.textContent = "That isn't an EVM (0x…) or Solana address.");
  if (wallets.some((w) => w.address.toLowerCase() === a.toLowerCase())) return void (err.textContent = "Already added.");
  if (wallets.length >= cap()) return void (err.textContent = "Wallet limit reached.");
  if (kindOf(a) === "solana" && !solanaRpc) err.textContent = "Added. Solana needs an RPC: open Settings.";
  else err.textContent = "";
  wallets.push({ address: a, label: label.value.trim().slice(0, 24) || undefined });
  store.set("wallets", wallets);
  input.value = label.value = "";
  renderWallets();
  void refresh();
});

$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  solanaRpc = $<HTMLInputElement>("sol-rpc").value.trim();
  licenseKey = $<HTMLInputElement>("license").value.trim();
  store.set("solanaRpc", solanaRpc);
  store.set("license", licenseKey);
  plan = checkLicense(licenseKey);
  renderPlan();
  renderWallets();
  $<HTMLDialogElement>("settings").close();
  void refresh();
});
$("open-settings").onclick = () => {
  $<HTMLInputElement>("sol-rpc").value = solanaRpc;
  $<HTMLInputElement>("license").value = licenseKey;
  $<HTMLDialogElement>("settings").showModal();
};
$("close-settings").onclick = () => $<HTMLDialogElement>("settings").close();
$("refresh").onclick = () => void refresh();
$("csv").onclick = () => {
  if (!plan.pro || !last) return;
  const day = new Date().toISOString().slice(0, 10);
  download(`lp-positions-${day}.csv`, toCsv(last.rows));
  if (history.length) download(`lp-history-${day}.csv`, historyCsv(history));
};

// ── share card (free: every card posted links back here) ──
const SHARE_URL = new URL("./?ref=card", location.href).href;
let cardBlob: Blob | null = null;
async function renderCard() {
  if (!last) return;
  const cv = drawCard(cardModel(last, $<HTMLInputElement>("share-amounts").checked), SHARE_URL, 2);
  cardBlob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/png"));
  const img = $<HTMLImageElement>("share-img");
  if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  if (cardBlob) img.src = URL.createObjectURL(cardBlob);
}
const cardFile = () => (cardBlob ? new File([cardBlob], "lp-positions.png", { type: "image/png" }) : null);
$("share").onclick = () => {
  if (!last) return;
  $("share-native").hidden = true;
  $<HTMLDialogElement>("share-dlg").showModal();
  void renderCard().then(() => ($("share-native").hidden = !(navigator.canShare?.({ files: [cardFile()!] }) ?? false)));
};
$("share-amounts").onchange = () => void renderCard();
$("share-png").onclick = () => {
  if (!cardBlob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(cardBlob);
  a.download = "lp-positions.png";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("share-native").onclick = () => {
  const f = cardFile();
  if (f) void navigator.share({ files: [f], text: "My LP positions", url: SHARE_URL }).catch(() => undefined);
};
$("share-x").onclick = () => {
  const text = "My LP positions across Uniswap v3/v4 and Meteora, tracked with a free read-only dashboard:";
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SHARE_URL)}`, "_blank", "noopener");
};

// ── data views ──
function renderTiles(s: Summary) {
  const out: string[] = [];
  for (const unit of ["ETH", "USD", "SOL"] as Unit[]) {
    const open = s.rows.filter((r) => r.unit === unit && r.status === "open");
    if (!open.length) continue;
    const t = s.totals[unit];
    const valued = open.filter((r) => r.valueNative !== undefined);
    const inRange = open.filter((r) => r.inRange).length;
    out.push(`<section class="unit"><h3>${unit === "USD" ? "Stablecoin pairs (USD)" : unit + " pairs"}</h3><div class="tiles">
      <div class="tile"><div class="k">Value</div><div class="v">${money(t.openValue, unit)}</div><div class="s">${valued.length} of ${open.length} valued</div></div>
      <div class="tile"><div class="k">Unclaimed fees</div><div class="v">${money(t.unclaimedFees, unit)}</div></div>
      <div class="tile"><div class="k">In range</div><div class="v">${inRange} <span class="of">of ${open.length}</span></div></div>
    </div></section>`);
  }
  $("tiles").innerHTML = out.join("") || (wallets.length ? '<p class="muted">No open LP positions found in these wallets.</p>' : "");
}

function renderPositions(s: Summary) {
  const open = s.rows.filter((r) => r.status === "open").sort((a, b) => (b.valueNative ?? -1) - (a.valueNative ?? -1));
  const walletName = (r: Row) => wallets.find((w) => w.address.toLowerCase() === r.wallet?.toLowerCase())?.label || short(r.wallet ?? "");
  const range = (r: Row) => (r.inRange === undefined ? "–" : r.inRange ? '<span class="state ok"><i></i>in range</span>' : '<span class="state off"><i></i>out of range</span>');
  $("positions").innerHTML = open.length
    ? `<thead><tr><th>Pair</th><th>Chain</th><th>Wallet</th><th class="num">Value</th><th class="num">Unclaimed fees</th><th>Range</th></tr></thead><tbody>` +
      open
        .map((r) => `<tr><td>${esc(r.pair)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</td><td>${esc(r.chain)}</td><td>${esc(walletName(r))}</td>
          <td class="num">${money(r.valueNative, r.unit)}</td><td class="num">${money(r.feesNative, r.unit)}</td><td>${range(r)}</td></tr>`)
        .join("") + "</tbody>"
    : "";
  $("positions-wrap").hidden = !open.length;
}

/** One small line chart per unit: value over time (single series, so no legend; the title names it). */
function renderHistory() {
  const box = $("history-charts");
  box.innerHTML = "";
  const days = daily(history);
  const rows: string[] = [];
  for (const unit of ["ETH", "USD", "SOL"] as Unit[]) {
    const pts = days.filter((d) => d.unit === unit);
    if (!pts.length) continue;
    const W = 640, H = 160, P = { l: 56, r: 12, t: 12, b: 24 };
    const xs = pts.map((p) => p.t), ys = pts.map((p) => p.value);
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 86_400_000);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.05 || 1;
    const y0 = lo - pad, y1 = hi + pad;
    const X = (t: number) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
    const Y = (v: number) => P.t + (1 - (v - y0) / (y1 - y0)) * (H - P.t - P.b);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join("");
    const fmt = (v: number) => money(v, unit);
    const fig = document.createElement("figure");
    fig.className = "chart";
    fig.innerHTML = `<figcaption>Value · ${unit}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Value of ${unit} positions per day; the table below lists the numbers">
        <line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(y1 - pad)}" y2="${Y(y1 - pad)}"/>
        <line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(y0 + pad)}" y2="${Y(y0 + pad)}"/>
        <text class="axis" x="${P.l - 8}" y="${Y(hi) + 4}" text-anchor="end">${esc(fmt(hi))}</text>
        <text class="axis" x="${P.l - 8}" y="${Y(lo) + 4}" text-anchor="end">${esc(fmt(lo))}</text>
        <text class="axis" x="${P.l}" y="${H - 6}">${new Date(x0).toISOString().slice(5, 10)}</text>
        <text class="axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${new Date(xs[xs.length - 1]!).toISOString().slice(5, 10)}</text>
        <path class="line" d="${line}"/>
        ${pts.length === 1 ? `<circle class="dot" cx="${X(pts[0]!.t)}" cy="${Y(pts[0]!.value)}" r="4"/>` : ""}
        <line class="cross" y1="${P.t}" y2="${H - P.b}" visibility="hidden"/>
        <circle class="dot hover" r="4" visibility="hidden"/>
        <rect class="hit" x="${P.l}" y="0" width="${W - P.l - P.r}" height="${H}"/>
      </svg>`;
    const svg = fig.querySelector("svg")!;
    const cross = svg.querySelector<SVGLineElement>(".cross")!;
    const dot = svg.querySelector<SVGCircleElement>(".hover")!;
    const tip = $("tip");
    svg.querySelector(".hit")!.addEventListener("pointermove", (e) => {
      const ev = e as PointerEvent;
      const box = svg.getBoundingClientRect();
      const t = x0 + (((ev.clientX - box.left) / box.width) * W - P.l) / (W - P.l - P.r) * (x1 - x0);
      const p = pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      for (const el of [cross, dot]) el.setAttribute("visibility", "visible");
      cross.setAttribute("x1", String(X(p.t)));
      cross.setAttribute("x2", String(X(p.t)));
      dot.setAttribute("cx", String(X(p.t)));
      dot.setAttribute("cy", String(Y(p.value)));
      tip.innerHTML = `${new Date(p.t).toISOString().slice(0, 10)}<br><b>${esc(fmt(p.value))}</b><br>fees ${esc(fmt(p.fees))} · ${p.positions} positions`;
      tip.hidden = false;
      tip.style.left = `${Math.min(ev.clientX + 12, innerWidth - 180)}px`;
      tip.style.top = `${ev.clientY + 12}px`;
    });
    svg.querySelector(".hit")!.addEventListener("pointerleave", () => {
      for (const el of [cross, dot]) el.setAttribute("visibility", "hidden");
      tip.hidden = true;
    });
    box.append(fig);
    for (const p of [...pts].reverse()) rows.push(`<tr><td>${new Date(p.t).toISOString().slice(0, 10)}</td><td>${unit}</td><td class="num">${esc(fmt(p.value))}</td><td class="num">${esc(fmt(p.fees))}</td><td class="num">${p.positions}</td></tr>`);
  }
  $("history-table").innerHTML = rows.length ? `<thead><tr><th>Day (UTC)</th><th>Unit</th><th class="num">Value</th><th class="num">Unclaimed fees</th><th class="num">Positions</th></tr></thead><tbody>${rows.join("")}</tbody>` : "";
  $("history-empty").hidden = rows.length > 0;
}


let busy = false;
async function refresh() {
  if (busy) return;
  if (!wallets.length) {
    last = null;
    $<HTMLButtonElement>("share").disabled = true;
    renderTiles({ rows: [], totals: { ETH: z(), SOL: z(), USD: z() }, daily: [], warnings: [], at: Date.now() });
    renderPositions({ rows: [], totals: { ETH: z(), SOL: z(), USD: z() }, daily: [], warnings: [], at: Date.now() });
    $("warnings").innerHTML = "";
    $("meta").textContent = "";
    return;
  }
  busy = true;
  $<HTMLButtonElement>("refresh").disabled = true;
  $("meta").textContent = "Reading the chains…";
  try {
    const s = await loadAll(wallets.slice(0, cap()), {
      solanaRpc: solanaRpc || undefined,
      onProgress: (d, t) => ($("meta").textContent = `Reading the chains… ${d}/${t}`),
    });
    last = s;
    $("warnings").innerHTML = s.warnings.map((w) => `<div class="warn"><b>Incomplete:</b> ${esc(w)}</div>`).join("");
    renderTiles(s);
    renderPositions(s);
    $<HTMLButtonElement>("share").disabled = !s.rows.some((r) => r.status === "open");
    if (plan.pro && trustworthy(s, seen)) {
      history = record(history, s);
      store.set("history", history);
    }
    seen = { ...seen, ...s.counts };
    store.set("seen", seen);
    if (plan.pro) renderHistory();
    $("meta").textContent = `Updated ${new Date(s.at).toLocaleTimeString()} · ${s.rows.filter((r) => r.status === "open").length} positions${plan.pro ? " · refreshes every 2 min" : ""}`;
  } catch (e) {
    $("meta").textContent = `Couldn't load: ${(e as Error).message}`;
  } finally {
    busy = false;
    $<HTMLButtonElement>("refresh").disabled = false;
  }
}

const z = () => ({ openValue: 0, unclaimedFees: 0, unrealized: 0, realized: 0, closed: 0, wins: 0 });

renderPlan();
renderWallets();
if (plan.pro) renderHistory();
void refresh();
