/**
 * One unattended pass of the Solana flash-loan scanner, for a scheduled job:
 *   SOL_PRIVATE_KEY=… SOL_ADDRESS=… npm run scan
 *
 * Borrows USDC from Kamino, round-trips it through each watched token on Jupiter at a few sizes,
 * and sends only a route whose full simulation from this wallet clears ARB_MIN_PROFIT (USDC).
 * Refuses to run when the key doesn't match SOL_ADDRESS, when the wallet holds any USDC (a losing
 * route would be paid from it instead of failing), or when it's low on SOL for fees.
 * DRY_RUN=1 simulates but never sends. A Telegram message goes to the owner only for a send.
 * ARB_PAYOUT_ADDRESS (a different Solana wallet) receives all of the bot wallet's USDC after
 * each profitable send, and any USDC left over at the start of a pass, so profits never sit in the
 * wallet whose key is on the runner, and the no-USDC rule never stops the scanner.
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadReserve, type Reserve } from "./kamino";
import { Jupiter } from "./jupiter";
import { buildAndSimulate, findRoute, fmtUnits, quoteRoundTrip } from "./arb";
import { solanaRpc, solKeypair } from "./cli";

/** Fallback when Jupiter's token list can't be read: liquid tokens that trade on several venues. */
export const MIDS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  POPCAT: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
};
const BATCH = 8;
const MIN_LIQUIDITY_USD = 200_000;
const SKIP = /^(USDC|USDT|USDG|PYUSD|USDS|USDE|USD1|FDUSD|DAI|SOL|WSOL)$/i;

interface ListedToken {
  id: string;
  symbol: string;
  isVerified?: boolean;
  tokenProgram?: string;
  liquidity?: number;
  usdPrice?: number;
  stats5m?: { priceChange?: number };
  stats1h?: { priceChange?: number };
}

/** A token to scan, with how much it's moving right now (gaps open when prices move fast). */
export interface Target {
  sym: string;
  id: string;
  /** |5-minute % change| + a quarter of |1-hour % change| */
  vol: number;
}

/**
 * The tokens worth scanning right now: Jupiter's most-traded (last 24h and last hour), verified,
 * on the classic token program (Token-2022 mints can carry transfer fees), with real liquidity,
 * and not stablecoins or SOL itself.
 */
export function pickTargets(lists: ListedToken[][]): Target[] {
  const out: Target[] = [];
  for (const t of lists.flat()) {
    if (!t?.id || !t.isVerified || !t.tokenProgram?.startsWith("Tokenkeg") || (t.liquidity ?? 0) < MIN_LIQUIDITY_USD) continue;
    if (SKIP.test(t.symbol) || (t.usdPrice !== undefined && Math.abs(t.usdPrice - 1) < 0.02)) continue;
    const vol = Math.abs(t.stats5m?.priceChange ?? 0) + Math.abs(t.stats1h?.priceChange ?? 0) / 4;
    const had = out.find((x) => x.id === t.id);
    if (had) had.vol = Math.max(had.vol, vol);
    else out.push({ sym: out.some((x) => x.sym === t.symbol) ? `${t.symbol}·${t.id.slice(0, 4)}` : t.symbol, id: t.id, vol });
  }
  return out;
}

export function pickMids(lists: ListedToken[][]): Record<string, string> {
  return Object.fromEntries(pickTargets(lists).map((t) => [t.sym, t.id]));
}

/** How many of the fastest movers every cycle re-checks, ahead of the rotating rest. */
export const HOT = 8;

/**
 * One cycle of the scan: the HOT fastest-moving tokens every time, then the next rotating batch of
 * the rest. A pass runs several cycles, so the movers get several looks per run and the rest one.
 */
export function cycleOrder(targets: Target[], cycle: number, now: number): Target[] {
  const byVol = [...targets].sort((a, b) => b.vol - a.vol || (a.id < b.id ? -1 : 1));
  const hot = byVol.filter((t) => t.vol > 0).slice(0, HOT);
  const rest = byVol.filter((t) => !hot.includes(t)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const batches = Math.max(1, Math.ceil(rest.length / BATCH));
  const i = (Math.floor(now / 300_000) + cycle) % batches;
  return [...hot, ...rest.slice(i * BATCH, i * BATCH + BATCH)];
}

export async function fetchTargets(env: NodeJS.ProcessEnv): Promise<Target[]> {
  const key = (env.JUPITER_API_KEY || "").trim();
  const base = key ? "https://api.jup.ag/tokens/v2" : "https://lite-api.jup.ag/tokens/v2";
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? (r.json() as Promise<ListedToken[]>) : []));
  const lists = await Promise.all([get("/toptraded/24h?limit=100"), get("/toptraded/1h?limit=100")]).catch(() => []);
  const t = pickTargets(lists.filter(Array.isArray));
  return t.length >= BATCH ? t : Object.entries(MIDS).map(([sym, id]) => ({ sym, id, vol: 0 }));
}

export async function fetchMids(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const key = (env.JUPITER_API_KEY || "").trim();
  const base = key ? "https://api.jup.ag/tokens/v2" : "https://lite-api.jup.ag/tokens/v2";
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? (r.json() as Promise<ListedToken[]>) : []));
  const lists = await Promise.all([get("/toptraded/24h?limit=100"), get("/toptraded/1h?limit=100")]).catch(() => []);
  const mids = pickMids(lists.filter(Array.isArray));
  return Object.keys(mids).length >= BATCH ? mids : MIDS;
}

/** The whole list, starting at this run's batch, so a pass that has time keeps going through the rest. */
export function rotation(mids: Record<string, string>, now: number): [string, string][] {
  const all = Object.entries(mids).sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const first = batchFor(mids, now)[0];
  const i = first ? all.findIndex(([, m]) => m === first[1]) : 0;
  return [...all.slice(i), ...all.slice(0, i)];
}

/** This run's slice: rotates every 5 minutes, so the whole list is covered every few runs. */
export function batchFor(mids: Record<string, string>, now: number, size = BATCH): [string, string][] {
  const all = Object.entries(mids).sort((a, b) => (a[1] < b[1] ? -1 : 1));
  const batches = Math.max(1, Math.ceil(all.length / size));
  const i = Math.floor(now / 300_000) % batches;
  return all.slice(i * size, i * size + size);
}

/** What to borrow: USDC and SOL see different pools (token/USDC vs token/SOL), so different gaps. */
const LOANS = [
  { sym: "USDC", sizes: [300n, 2_000n] },
  { sym: "SOL", sizes: [2n, 12n] },
] as const;
/** price checks in flight at once (Jupiter's rate limit backs the rest off) */
const DEFAULT_CONCURRENCY = 3;
/** share of the simulated profit offered as a priority fee, to win the race for a gap */
const TIP_SHARE = 0.25;
const MAX_TIP_LAMPORTS = 2_000_000;

/** Priority fee for a win worth `profitUsd`: TIP_SHARE of it, capped; as micro-lamports per CU for `computeUnits`. */
export function priorityFee(profitUsd: number, solUsd: number, computeUnits: number): { lamports: number; microLamports: number } {
  if (!(profitUsd > 0) || !(solUsd > 0) || !(computeUnits > 0)) return { lamports: 0, microLamports: 0 };
  const lamports = Math.min(MAX_TIP_LAMPORTS, Math.floor(((profitUsd * TIP_SHARE) / solUsd) * 1e9));
  return { lamports, microLamports: Math.floor((lamports * 1e6) / computeUnits) };
}
/** Kamino's flash fee measured on mainnet is 0.001%; quotes use 2× as a margin */
const FEE_PPM = 20n;
/** keep enough SOL for fees and the few token accounts Jupiter creates on first use */
const MIN_SOL_LAMPORTS = 20_000_000;
const SLIPPAGE_BPS = 30;
/** each pass keeps cycling through the token list for this long (the job runs every 5 minutes) */
const BUDGET_MS = 200_000;

export interface Pass {
  checked: number;
  candidates: number;
  sent: { sig: string; profit: string; route: string }[];
  notes: string[];
  /** closest quoted round trip this pass (USDC; negative = a loss), and on which token */
  best?: { usd: number; sym: string };
  /** USDC paid out to ARB_PAYOUT_ADDRESS this pass */
  paidOut?: number;
  /** wallet SOL at the start of the pass */
  sol?: number;
}

/** One UTC day of scan results, kept for the shop bot's /bot command (the last 7 days). */
export interface DayStats {
  day: string;
  runs: number;
  quotes: number;
  candidates: number;
  sent: number;
  profit: number;
  paidOut: number;
  best?: { usd: number; sym: string };
  errors: number;
  lastAt: number;
  lastNote?: string;
  sol?: number;
}

/** Fold one pass into the per-day stats (pure; the caller reads and writes the file). */
export function recordPass(days: DayStats[], p: Pass, now: number): DayStats[] {
  const day = new Date(now).toISOString().slice(0, 10);
  const out = days.filter((d) => d.day !== day);
  const d: DayStats = days.find((x) => x.day === day) ?? { day, runs: 0, quotes: 0, candidates: 0, sent: 0, profit: 0, paidOut: 0, errors: 0, lastAt: 0 };
  d.runs++;
  d.quotes += p.checked;
  d.candidates += p.candidates;
  d.sent += p.sent.length;
  d.profit += p.sent.reduce((a, x) => a + Number(x.profit), 0);
  d.paidOut += p.paidOut ?? 0;
  if (p.best && (!d.best || p.best.usd > d.best.usd)) d.best = p.best;
  const problems = p.notes.filter((n) => !n.startsWith("batch:"));
  d.errors += problems.filter((n) => /fail|error|refus|needs at least|holds|HTTP|429/i.test(n)).length;
  if (problems.length) d.lastNote = problems.at(-1)!.slice(0, 200);
  d.lastAt = now;
  if (p.sol !== undefined) d.sol = p.sol;
  return [...out, d].sort((a, b) => a.day.localeCompare(b.day)).slice(-7);
}

function saveStats(file: string, p: Pass, now: number) {
  let days: DayStats[] = [];
  try {
    days = JSON.parse(fs.readFileSync(file, "utf8")) as DayStats[];
  } catch {
    /* first run */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(recordPass(days, p, now), null, 1));
}

async function notify(text: string, env: NodeJS.ProcessEnv) {
  const token = (env.SHOP_TG_TOKEN || "").trim();
  const chat = (env.TG_OWNER_ID || "").trim();
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

/** Why a pass must not run, if it must not: the safety checks, before any quote. */
export async function preflight(conn: Connection, r: Reserve, payer: PublicKey, expected: string, sym = "USDC"): Promise<string | null> {
  if (payer.toBase58() !== expected) return `SOL_PRIVATE_KEY is for ${payer.toBase58()}, not SOL_ADDRESS ${expected}: refusing`;
  const lamports = await conn.getBalance(payer);
  if (lamports < MIN_SOL_LAMPORTS) return `wallet has ${lamports / 1e9} SOL; needs at least ${MIN_SOL_LAMPORTS / 1e9} for fees`;
  const usdc = await conn
    .getTokenAccountBalance(getAssociatedTokenAddressSync(r.mint, payer, true, r.tokenProgram))
    .then((b) => BigInt(b.value.amount))
    .catch(() => 0n);
  if (usdc > 0n) return `wallet holds ${fmtUnits(usdc, r.decimals)} ${sym === "SOL" ? "wrapped SOL" : sym}: move it out (with a balance, a losing route would be paid from it)`;
  return null;
}

/** The payout wallet from ARB_PAYOUT_ADDRESS: must be a valid Solana address other than the bot's own. */
export function payoutTarget(env: NodeJS.ProcessEnv, self: PublicKey): PublicKey | null {
  const raw = (env.ARB_PAYOUT_ADDRESS || "").trim();
  if (!raw) return null;
  let to: PublicKey;
  try {
    to = new PublicKey(raw);
  } catch {
    throw new Error("ARB_PAYOUT_ADDRESS isn't a Solana address (it must be a Solana wallet, not 0x…)");
  }
  if (to.equals(self)) throw new Error("ARB_PAYOUT_ADDRESS is the bot wallet itself: use a different wallet");
  return to;
}

/** Create the payout wallet's USDC account if missing, then move `amount` there. */
export function sweepInstructions(r: Reserve, from: PublicKey, to: PublicKey, amount: bigint): TransactionInstruction[] {
  const src = getAssociatedTokenAddressSync(r.mint, from, true, r.tokenProgram);
  const dst = getAssociatedTokenAddressSync(r.mint, to, true, r.tokenProgram);
  return [
    createAssociatedTokenAccountIdempotentInstruction(from, dst, to, r.mint, r.tokenProgram),
    createTransferCheckedInstruction(src, r.mint, dst, from, amount, r.decimals, [], r.tokenProgram),
  ];
}

/** Send the bot wallet's whole USDC balance to the payout wallet. Returns the amount and signature, or null if there was none. */
export async function sweep(conn: Connection, kp: Keypair, r: Reserve, to: PublicKey): Promise<{ amount: bigint; sig: string } | null> {
  const src = getAssociatedTokenAddressSync(r.mint, kp.publicKey, true, r.tokenProgram);
  const amount = await conn.getTokenAccountBalance(src).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  if (amount === 0n) return null;
  const tx = new Transaction().add(...sweepInstructions(r, kp.publicKey, to, amount));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await conn.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error(`payout ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return { amount, sig };
}

export async function scanOnce(env: NodeJS.ProcessEnv = process.env): Promise<Pass> {
  const started = Date.now();
  const conn = new Connection(solanaRpc(env), "confirmed");
  const kp = solKeypair(env);
  const usdc = await loadReserve(conn, "USDC");
  const wsol = await loadReserve(conn, "SOL");
  const reserves: Record<string, Reserve> = { USDC: usdc, SOL: wsol };
  const pass: Pass = { checked: 0, candidates: 0, sent: [], notes: [] };
  const dry = env.DRY_RUN === "1";
  const payout = payoutTarget(env, kp.publicKey);
  const jup = new Jupiter(env.JUPITER_API_KEY || "");

  // SOL's USD price, to compare USDC and SOL loans in one unit and to size the priority fee
  const solQuote = await jup.quote(wsol.mint.toBase58(), usdc.mint.toBase58(), 1_000_000_000n, 50).catch(() => null);
  const solUsd = solQuote ? Number(solQuote.outAmount) / 1e6 : NaN;
  const toUsd = (raw: bigint, loan: string) => (loan === "SOL" ? (Number(raw) / 1e9) * solUsd : Number(raw) / 1e6);

  const payOut = async (loan: string, why: string) => {
    if (!payout || dry) return;
    const r = reserves[loan]!;
    try {
      const p = await sweep(conn, kp, r, payout);
      if (!p) return;
      pass.paidOut = (pass.paidOut ?? 0) + toUsd(p.amount, loan);
      const what = `${fmtUnits(p.amount, r.decimals)} ${loan === "SOL" ? "wrapped SOL" : loan}`;
      pass.notes.push(`paid out ${what} to ${payout.toBase58()} (${why}): ${p.sig}`);
      await notify(`📤 Sent ${what} to your payout wallet (${why})\nhttps://solscan.io/tx/${p.sig}`, env);
    } catch (e) {
      pass.notes.push(`payout failed (${why}): ${(e as Error).message.slice(0, 160)}`);
    }
  };
  for (const loan of Object.keys(reserves)) await payOut(loan, "left in the bot wallet");
  for (const loan of Object.keys(reserves)) {
    const stop = await preflight(conn, reserves[loan]!, kp.publicKey, (env.SOL_ADDRESS || "").trim(), loan);
    if (stop) {
      pass.sol = (await conn.getBalance(kp.publicKey).catch(() => NaN)) / 1e9;
      pass.notes.push(stop);
      return pass;
    }
  }
  pass.sol = (await conn.getBalance(kp.publicKey).catch(() => NaN)) / 1e9;

  const targets = await fetchTargets(env);
  const hot = cycleOrder(targets, 0, started).slice(0, HOT);
  pass.notes.push(`batch: ${cycleOrder(targets, 0, started).map((t) => t.sym).join(", ")} (of ${targets.length}; movers first: ${hot.map((t) => `${t.sym} ${t.vol.toFixed(1)}%`).join(", ") || "none"})`);
  const minUsd = Number(env.ARB_MIN_PROFIT || "0.05");
  const loans = LOANS.filter((l) => l.sym === "USDC" || solUsd > 0);

  // the work: every (token, loan, size) of a cycle, cycle after cycle, until the time budget is used
  type Job = { t: Target; loan: string; size: bigint };
  let cycle = 0;
  let queue: Job[] = [];
  const next = (): Job | null => {
    if (Date.now() - started > BUDGET_MS) return null;
    if (!queue.length) {
      queue = cycleOrder(targets, cycle++, started).flatMap((t) => loans.flatMap((l) => l.sizes.map((size) => ({ t, loan: l.sym, size }))));
      if (!queue.length) return null;
    }
    return queue.shift()!;
  };
  // building, simulating and sending happen one at a time: one wallet, one set of token accounts
  let lock: Promise<void> = Promise.resolve();
  const exclusive = (f: () => Promise<void>) => (lock = lock.then(f, f));

  const tryCandidate = async (j: Job, r: Reserve, amount: bigint, fee: bigint, label: string) => {
    const minRaw = j.loan === "SOL" ? BigInt(Math.ceil((minUsd / solUsd) * 1e9)) : BigInt(Math.round(minUsd * 1e6));
    const found = await findRoute(conn, jup, r, kp.publicKey, j.t.id, amount, fee, SLIPPAGE_BPS);
    if (!found || !found.built.ok || found.built.delta! <= minRaw) {
      pass.notes.push(`${label}: ${found?.built.ok ? `simulated ${toUsd(found.built.delta!, j.loan).toFixed(3)} USD` : `simulation failed: ${found?.built.error ?? "no route"}`}`);
      return;
    }
    // pay a share of the profit as a priority fee, with a compute limit fitted to the simulation
    const cu = Math.ceil((found.built.units ?? 400_000) * 1.15) + 10_000;
    const profitUsd = toUsd(found.built.delta!, j.loan);
    const tip = priorityFee(profitUsd, solUsd, cu);
    const final = tip.microLamports ? await buildAndSimulate(conn, jup, r, kp.publicKey, found.built.trip, { priorityMicroLamports: tip.microLamports, computeUnits: cu }) : found;
    const netUsd = toUsd(final.built.delta ?? 0n, j.loan) - (tip.lamports / 1e9) * solUsd;
    if (!final.built.ok || netUsd <= minUsd) {
      pass.notes.push(`${label}: profitable at first, not after the priority fee (${final.built.ok ? `net ${netUsd.toFixed(3)} USD` : final.built.error})`);
      return;
    }
    const route = `${final.built.trip.buy.route} → ${final.built.trip.sell.route}`;
    if (dry) {
      pass.notes.push(`${label}: would send, simulated +${netUsd.toFixed(3)} USD net via ${route}`);
      return;
    }
    final.tx.sign([kp]);
    const sig = await conn.sendRawTransaction(final.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const res = await conn.confirmTransaction(sig, "confirmed");
    if (res.value.err) {
      pass.notes.push(`${label}: sent ${sig} but it failed on chain (the gap closed): ${JSON.stringify(res.value.err)}`);
      return;
    }
    const profit = netUsd.toFixed(4);
    pass.sent.push({ sig, profit, route });
    await notify(`💰 Flash arb: +$${profit} (simulated, after a ${(tip.lamports / 1e9).toFixed(5)} SOL priority fee) via ${j.t.sym}, ${label.split(" ").slice(1).join(" ")} borrowed\n${route}\nhttps://solscan.io/tx/${sig}`, env);
    await payOut(j.loan, "profit");
  };

  const worker = async () => {
    for (let j = next(); j; j = next()) {
      const r = reserves[j.loan]!;
      const amount = j.size * 10n ** BigInt(r.decimals);
      const fee = (amount * FEE_PPM) / 1_000_000n;
      const label = `${j.t.sym} ${j.size} ${j.loan}`;
      pass.checked++;
      try {
        const trip = await quoteRoundTrip(jup, r.mint.toBase58(), j.t.id, amount, fee, SLIPPAGE_BPS);
        if (!trip) continue;
        const usd = toUsd(trip.expected, j.loan);
        if (Number.isFinite(usd) && (!pass.best || usd > pass.best.usd)) pass.best = { usd: Math.round(usd * 1e4) / 1e4, sym: label };
        if (!(usd > minUsd)) continue;
        pass.candidates++;
        const job = j;
        await exclusive(() => tryCandidate(job, r, amount, fee, label).catch((e) => void pass.notes.push(`${label}: ${(e as Error).message.slice(0, 160)}`)));
      } catch (e) {
        pass.notes.push(`${label}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  };
  const n = Math.max(1, Math.min(6, Number(env.ARB_CONCURRENCY || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY));
  await Promise.all(Array.from({ length: n }, worker));
  await lock;
  if (!loans.some((l) => l.sym === "SOL")) pass.notes.push("SOL loans skipped this pass: couldn't price SOL");
  return pass;
}

if (process.argv[1]?.endsWith("scan.ts")) {
  scanOnce()
    .then((p) => {
      console.log(`scan: ${p.checked} quotes, ${p.candidates} candidates, ${p.sent.length} sent`);
      for (const n of p.notes) console.log(`  ${n}`);
      for (const s of p.sent) console.log(`  SENT +$${s.profit} ${s.sig}`);
      const file = (process.env.ARB_STATS_FILE || "").trim();
      if (file) saveStats(file, p, Date.now());
    })
    .catch((e) => {
      console.error(`scan: ${(e as Error).message}`);
      const file = (process.env.ARB_STATS_FILE || "").trim();
      if (file) saveStats(file, { checked: 0, candidates: 0, sent: [], notes: [`error: ${(e as Error).message}`] }, Date.now());
      process.exit(1);
    });
}
