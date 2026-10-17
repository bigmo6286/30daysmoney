/**
 * The agent: one serialized loop (no concurrent writers to the state files).
 * Every manageSec: value each open position from the chain, apply exit rules, close.
 * Every scanMin: rescreen pools; if autoEnabled and within caps, open the best one that
 * passes every gate. All decisions are code; settings are the only knobs.
 */
import path from "node:path";
import type { Settings } from "../config";
import type { Executor, PoolReader } from "../chain/dlmm";
import { shortErr } from "../chain/solana";
import { exitReason } from "../exits";
import { binsForDownside, depthOf, rangeState } from "../range";
import type { ClosedRec, PositionBook, PositionRec } from "../positions";
import { readJson, writeJsonAtomic } from "../store";
import { esc, pct, signedSol, sol } from "../format";
import { logger } from "../log";
import type { DiscoveryQuery, Pool } from "./discovery";
import { rank, type Ranked, type Rejected } from "./screen";
import type { GateResult, Gates } from "./gates";

const log = logger("agent");
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

interface AgentState {
  day: string;
  spentSol: number;
  /** pool address or mint → until (ms) */
  cooldowns: Record<string, number>;
  blocked: string[];
  lastReportDay: string;
}

export type Notify = (text: string) => Promise<unknown>;

export interface AgentDeps {
  exec: Executor;
  pools: PoolReader;
  gates: Gates;
  discover: (q: DiscoveryQuery) => Promise<Pool[]>;
  book: PositionBook;
  settings: () => Settings;
  notify: Notify;
  /** wallet SOL; null in paper mode (no balance check) */
  balanceSol: (() => Promise<number>) | null;
  dataDir: string;
}

export class Agent {
  state: AgentState;
  ranked: Ranked[] = [];
  rejected: Rejected[] = [];
  /** every pool seen in the last scan, by address */
  seen = new Map<string, Pool>();
  lastScanAt = 0;
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** positions whose close failure was already reported (one alert per failure streak) */
  private closeFailed = new Set<string>();
  private warnedNoScreener = false;

  constructor(private readonly d: AgentDeps) {
    this.file = path.join(d.dataDir, "agent.json");
    this.state = readJson<AgentState>(this.file, { day: day(), spentSol: 0, cooldowns: {}, blocked: [], lastReportDay: day() });
  }

  private save() {
    writeJsonAtomic(this.file, this.state);
  }

  get paper() {
    return this.d.exec.paper;
  }

  get screener() {
    return this.d.gates.screener;
  }

  start() {
    const loop = async () => {
      await this.tick().catch((e) => log.warn(`tick failed: ${shortErr(e)}`));
      this.timer = setTimeout(loop, this.d.settings().manageSec * 1000);
    };
    this.timer = setTimeout(loop, 5_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.d.settings();
      await this.manage(s);
      if (Date.now() - this.lastScanAt >= s.scanMin * 60_000) {
        await this.scan(s);
        if (s.autoEnabled) await this.maybeOpen(s);
      }
      await this.maybeReport(s);
    } finally {
      this.busy = false;
    }
  }

  spentToday(): number {
    if (this.state.day !== day()) {
      this.state.day = day();
      this.state.spentSol = 0;
      this.save();
    }
    return this.state.spentSol;
  }

  block(mint: string) {
    if (!this.state.blocked.includes(mint)) this.state.blocked.push(mint);
    this.save();
  }

  private cool(key: string, s: Settings) {
    this.state.cooldowns[key] = Date.now() + s.cooldownHours * 3_600_000;
    this.save();
  }

  /** Why the agent wouldn't consider this pool right now (cheap checks, no RPC). */
  skipReason(p: Pool): string | null {
    const now = Date.now();
    if (this.state.blocked.includes(p.mint)) return "blocked";
    if ((this.state.cooldowns[p.mint] ?? 0) > now || (this.state.cooldowns[p.address] ?? 0) > now) return "cooldown";
    if (this.d.book.open().some((r) => r.mint === p.mint)) return "already held";
    return null;
  }

  async scan(s: Settings): Promise<Ranked[]> {
    const pools = await this.d.discover(s);
    const { ranked, rejected } = rank(pools, s);
    this.ranked = ranked;
    this.rejected = rejected;
    this.seen = new Map(pools.map((p) => [p.address, p]));
    this.lastScanAt = Date.now();
    for (const rec of this.d.book.open()) {
      const p = this.seen.get(rec.pool);
      if (p) rec.feeTvlPct = p.feeTvlPct;
    }
    this.d.book.save();
    log.info(`scan: ${pools.length} pools, ${ranked.length} pass screening`);
    return ranked;
  }

  private others(p: Pool) {
    return [...new Set([...this.seen.values()].filter((x) => x.mint !== p.mint).map((x) => x.symbol))];
  }

  /** Run every gate for a pool (used by the auto loop, /check and /open). */
  check(p: Pool, s: Settings, opts?: { skipScreen?: boolean }): Promise<GateResult> {
    return this.d.gates.check(p, s.sizeSol, s, this.others(p), opts);
  }

  private async maybeOpen(s: Settings) {
    const auto = this.d.book.open().filter((r) => r.auto);
    if (auto.length >= s.maxOpen) return;
    if (this.spentToday() + s.sizeSol > s.dailySol) return;
    if (s.screen && !this.screener) {
      if (!this.warnedNoScreener) {
        this.warnedNoScreener = true;
        await this.d.notify("⚠️ Autopilot won't open: Jev screening is on but <code>TYPESAFE_API_KEY</code> is not set. Add the key and restart, or <code>/set screen off</code>.");
      }
      return;
    }
    if (this.d.balanceSol && (await this.d.balanceSol()) < s.sizeSol + s.gasReserveSol) {
      log.info("not enough SOL for another position");
      return;
    }
    for (const c of this.ranked) {
      if (this.skipReason(c.pool)) continue;
      const g = await this.check(c.pool, s);
      if (!g.ok) {
        log.info(`skip ${c.pool.symbol}: ${g.reason}`);
        if (!g.error) this.cool(c.pool.mint, s);
        continue;
      }
      try {
        await this.open(c.pool, s.sizeSol, s, true, g);
      } catch (e) {
        log.warn(`open ${c.pool.symbol} failed: ${shortErr(e)}`);
        this.cool(c.pool.address, s);
        await this.d.notify(`⚠️ Open ${esc(c.pool.symbol)} failed: ${esc(shortErr(e))}`);
      }
      return; // at most one open per scan
    }
  }

  async open(p: Pool, sizeSol: number, s: Settings, auto: boolean, g?: GateResult): Promise<PositionRec> {
    const snap = await this.d.pools.read(p.address);
    const bins = binsForDownside(s.downsidePct, snap.binStep, s.minBins, s.maxBins);
    const o = await this.d.exec.open(p.address, snap, sizeSol, bins, s);
    const rec: PositionRec = {
      id: this.d.book.nextId(),
      pool: p.address,
      position: o.position,
      mint: p.mint,
      symbol: p.symbol,
      solIsX: snap.solIsX,
      binStep: snap.binStep,
      entryId: o.entryId,
      minBinId: o.minBinId,
      maxBinId: o.maxBinId,
      bins,
      depositSol: sizeSol,
      spentSol: o.spentSol,
      openedAt: Date.now(),
      auto,
      peakPnlPct: 0,
      feeTvlPct: p.feeTvlPct,
    };
    this.d.book.put(rec);
    this.state.spentSol = this.spentToday() + sizeSol;
    this.save();
    const a = g?.assessment;
    await this.d.notify(
      `${auto ? "🤖 Auto-opened" : "✅ Opened"} <b>#${rec.id}</b> ${esc(p.symbol)} · ${sol(sizeSol)} SOL · ${bins + 1} bins (−${s.downsidePct}%)${this.paper ? " <i>[paper]</i>" : ""}\n` +
        `fee/TVL ${p.feeTvlPct.toFixed(2)}% (${s.timeframe}) · TVL $${Math.round(p.tvlUsd).toLocaleString("en-US")}` +
        (g?.roundTripLossPct !== undefined ? ` · round trip −${g.roundTripLossPct.toFixed(1)}%` : "") +
        (a ? `\nscreen (${esc(a.source)}): copycat ${(a.copycat * 100).toFixed(0)}% · rug ${(a.rugSigns * 100).toFixed(0)}% · risk ${(a.risk * 100).toFixed(0)}%` : ""),
    );
    return rec;
  }

  /** Value one position and update its peak / out-of-range timers. */
  async status(rec: PositionRec, s: Settings) {
    const v = await this.d.exec.value(rec, s);
    const pnlSol = v.valueSol - rec.depositSol;
    const pnlPct = (pnlSol / rec.depositSol) * 100;
    rec.peakPnlPct = Math.max(rec.peakPnlPct, pnlPct);
    const range = rangeState(depthOf(rec.entryId, v.activeId, rec.solIsX), rec.bins);
    const now = Date.now();
    if (range === "in") delete rec.oor;
    else if (rec.oor?.state !== range) rec.oor = { state: range, since: now };
    return { ...v, pnlSol, pnlPct, range, oorMin: rec.oor ? (now - rec.oor.since) / 60_000 : 0 };
  }

  private async manage(s: Settings) {
    for (const rec of [...this.d.book.open()]) {
      let st;
      try {
        st = await this.status(rec, s);
      } catch (e) {
        log.warn(`value #${rec.id} failed: ${shortErr(e)}`);
        continue;
      }
      this.d.book.put(rec);
      const reason = exitReason({ ageMin: (Date.now() - rec.openedAt) / 60_000, pnlPct: st.pnlPct, peakPnlPct: rec.peakPnlPct, range: st.range, oorMin: st.oorMin, feeTvlPct: rec.feeTvlPct }, s);
      if (reason) await this.close(rec.id, reason).catch((e) => log.warn(`close #${rec.id} failed: ${shortErr(e)}`));
    }
  }

  async close(id: string, reason: string): Promise<ClosedRec> {
    const s = this.d.settings();
    const rec = this.d.book.get(id);
    if (!rec) throw new Error(`no open position #${id}`);
    let receivedSol: number;
    try {
      receivedSol = await this.d.exec.close(rec, s);
    } catch (e) {
      if (!this.closeFailed.has(id)) {
        this.closeFailed.add(id);
        await this.d.notify(`⚠️ Close #${id} ${esc(rec.symbol)} (${esc(reason)}) failed: ${esc(shortErr(e))}\nRetrying every cycle; /close ${id} to retry now.`);
      }
      throw e;
    }
    this.closeFailed.delete(id);
    const pnlSol = receivedSol - rec.spentSol;
    const closed = this.d.book.close(id, { closedAt: Date.now(), receivedSol, pnlSol, pnlPct: (pnlSol / rec.depositSol) * 100, reason });
    this.cool(rec.mint, s);
    this.cool(rec.pool, s);
    await this.d.notify(`${rec.auto ? "🤖 Auto-closed" : "Closed"} #${id} ${esc(rec.symbol)}: ${esc(reason)}\nPnL ${signedSol(pnlSol)} SOL (${pct(closed.pnlPct)})${this.paper ? " <i>[paper]</i>" : ""}`);
    return closed;
  }

  /** Once per UTC day: yesterday's realized result + what's open now. */
  private async maybeReport(s: Settings) {
    const today = day();
    if (this.state.lastReportDay === today) return;
    const yesterday = this.state.lastReportDay;
    this.state.lastReportDay = today;
    this.save();
    if (!s.dailyReport) return;
    const closed = this.d.book.closed().filter((r) => day(r.closedAt) === yesterday);
    const pnl = closed.reduce((a, r) => a + r.pnlSol, 0);
    const wins = closed.filter((r) => r.pnlSol > 0).length;
    await this.d.notify(
      `📊 <b>Daily report</b> ${yesterday}${this.paper ? " <i>[paper]</i>" : ""}\n` +
        `closed ${closed.length} (${wins} wins) · PnL ${signedSol(pnl)} SOL\n` +
        `open now: ${this.d.book.open().length} · auto ${s.autoEnabled ? "ON" : "off"}`,
    );
  }
}
