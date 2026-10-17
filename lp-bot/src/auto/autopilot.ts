/**
 * Autopilot: every scan, rotate out of faded / stuck auto positions, then open the best
 * candidate that passes every gate. All caps are hard limits; nothing here runs unless
 * autoEnabled is on.
 */
import path from "node:path";
import { ethers } from "ethers";
import type { LpService } from "../lp/service";
import type { PoolView } from "../chain/pools";
import type { Scanner, Candidate } from "./scanner";
import type { Settings } from "../config";
import { tokenFacts, type TokenFacts } from "./facts";
import { screenVerdict, type Assessment, type Screener } from "./screen";
import { readJson, writeJsonAtomic } from "../store";
import { esc, eth, feeTier, pct, signedEth } from "../core/format";
import { shortErr } from "../chain/client";
import { logger } from "../log";

const log = logger("auto");
const pct0 = (p: number) => `${(p * 100).toFixed(0)}%`;
const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

interface AutoState {
  day: string;
  spentWei: string;
  cooldowns: Record<string, number>; // token → until (ms)
  blocked: string[];
  lastReportDay: string;
}

export type Notify = (text: string) => Promise<unknown>;

export interface GateResult {
  ok: boolean;
  reason?: string;
}

export interface ScreenResult extends GateResult {
  assessment?: Assessment;
  facts?: TokenFacts;
  /** the screener couldn't answer (API down etc.): not the token's fault, so no cooldown */
  error?: boolean;
}

export class Autopilot {
  private file: string;
  state: AutoState;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private warnedNoScreener = false;

  constructor(
    private readonly lp: LpService,
    readonly scanner: Scanner,
    private readonly settings: () => Settings,
    private readonly notify: Notify,
    dataDir: string,
    readonly screener?: Screener,
  ) {
    this.file = path.join(dataDir, "autopilot.json");
    this.state = readJson<AutoState>(this.file, { day: day(), spentWei: "0", cooldowns: {}, blocked: [], lastReportDay: day() });
  }

  private save() {
    writeJsonAtomic(this.file, this.state);
  }

  start() {
    const loop = async () => {
      await this.tick().catch((e) => log.warn(`tick failed: ${shortErr(e)}`));
      this.timer = setTimeout(loop, this.settings().autoScanMin * 60_000);
    };
    this.timer = setTimeout(loop, 10_000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  block(token: string) {
    const t = ethers.getAddress(token);
    if (!this.state.blocked.includes(t)) this.state.blocked.push(t);
    this.save();
  }

  spentToday(): bigint {
    if (this.state.day !== day()) {
      this.state.day = day();
      this.state.spentWei = "0";
      this.save();
    }
    return BigInt(this.state.spentWei);
  }

  autoPositions() {
    return this.lp.book.open().filter((r) => r.auto);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.scanner.scan();
      await this.maybeReport();
      if (!this.settings().autoEnabled) return;
      await this.rotateOut();
      await this.maybeOpen();
    } finally {
      this.busy = false;
    }
  }

  /** Static gates on a scanned pool (no RPC). */
  gate(c: Candidate, set: Settings): GateResult {
    const now = Date.now();
    if (c.samples < 2) return { ok: false, reason: "not enough samples yet" };
    if (c.aprEmaPct < set.autoMinAprPct) return { ok: false, reason: `APR ${c.aprEmaPct.toFixed(0)}% < ${set.autoMinAprPct}%` };
    if (c.depthWei < ethers.parseEther(String(set.autoMinDepthEth))) return { ok: false, reason: "pool too shallow" };
    if (Math.abs(c.movePct) > set.autoMaxMovePct) return { ok: false, reason: `price moved ${pct(c.movePct)}` };
    if (this.state.blocked.includes(c.token)) return { ok: false, reason: "blocked" };
    if ((this.state.cooldowns[c.token] ?? 0) > now) return { ok: false, reason: "cooldown" };
    if (this.lp.book.open().some((r) => r.token === c.token)) return { ok: false, reason: "already held" };
    return { ok: true };
  }

  /** Round-trip quote: buy then sell back. Catches pools you can buy into but not get out of. */
  async roundTrip(c: Candidate, sizeWei: bigint): Promise<GateResult> {
    const buy = await this.lp.quote(this.lp.chain.contracts.weth, c.token, sizeWei);
    if (buy.out === 0n) return { ok: false, reason: "no buy route" };
    const sell = await this.lp.quote(c.token, this.lp.chain.contracts.weth, buy.out);
    if (sell.out === 0n) return { ok: false, reason: "cannot sell (honeypot?)" };
    const ratio = Number((sell.out * 10_000n) / sizeWei) / 10_000;
    const expected = (1 - buy.fee / 1e6) * (1 - sell.fee / 1e6);
    if (ratio < expected - 0.03) return { ok: false, reason: `round trip returns ${(ratio * 100).toFixed(1)}%` };
    return { ok: true };
  }

  /** Gather on-chain facts and ask the screener; settings decide what blocks. */
  async screen(c: Candidate, set: Settings): Promise<ScreenResult> {
    if (!this.screener) return { ok: false, error: true, reason: "no screener configured" };
    let assessment: Assessment;
    let facts: TokenFacts;
    try {
      facts = await tokenFacts(this.lp.chain, c.token, c.pool);
      const others = [...new Set(this.scanner.ranked().filter((x) => x.token !== c.token).map((x) => x.symbol))];
      assessment = await this.screener.assess(facts, c, others);
    } catch (e) {
      return { ok: false, error: true, reason: `screen failed: ${shortErr(e)}` };
    }
    return { ...this.verdict(assessment, set), assessment, facts };
  }

  verdict(a: Assessment, set: Settings): GateResult {
    return screenVerdict(a, {
      maxCopycat: set.autoMaxCopycatPct / 100,
      maxRugSigns: set.autoMaxRugPct / 100,
      maxRisk: set.autoMaxRiskPct / 100,
    });
  }

  /** The screener's last answer for a token, if still cached (no API call). */
  cachedScreen(token: string, set: Settings): ScreenResult | undefined {
    const a = this.screener?.peek?.(token);
    return a && { ...this.verdict(a, set), assessment: a };
  }

  /** Screen any token on demand: the tracked pool if the scanner has one, else `deepest` (or a lookup). */
  async screenToken(token: string, deepest?: PoolView): Promise<ScreenResult & { symbol: string }> {
    const t = ethers.getAddress(token);
    let c = this.scanner
      .ranked()
      .filter((x) => x.token === t)
      .sort((a, b) => (b.depthWei > a.depthWei ? 1 : -1))[0];
    if (!c) {
      const p = deepest ?? (await this.lp.findPools(t))[0];
      if (!p) return { ok: false, error: true, reason: "no WETH pool with liquidity", symbol: t };
      c = { pool: p.address, token: t, symbol: p.token.symbol, fee: p.fee, depthWei: p.quoteReserve, priceE18: p.priceE18, aprPct: 0, aprEmaPct: 0, movePct: 0, swaps: 0, samples: 0, updatedAt: Date.now() };
    }
    return { ...(await this.screen(c, this.settings())), symbol: c.symbol };
  }

  private async maybeOpen() {
    const set = this.settings();
    const size = ethers.parseEther(String(set.autoSizeEth));
    if (this.autoPositions().length >= set.autoMaxOpen) return;
    if (this.spentToday() + size > ethers.parseEther(String(set.autoDailyEth))) return;
    if (set.autoScreen && !this.screener) {
      if (!this.warnedNoScreener) {
        this.warnedNoScreener = true;
        log.warn("autoScreen is on but TYPESAFE_API_KEY is not set: not opening anything");
        await this.notify("⚠️ Autopilot won't open: token screening is on but <code>TYPESAFE_API_KEY</code> is not set. Add the key and restart, or <code>/set autoScreen off</code>.");
      }
      return;
    }
    for (const c of this.scanner.ranked()) {
      if (!this.gate(c, set).ok) continue;
      const rt = await this.roundTrip(c, size);
      if (!rt.ok) {
        log.info(`skip ${c.symbol}: ${rt.reason}`);
        this.state.cooldowns[c.token] = Date.now() + set.autoCooldownHours * 3_600_000;
        this.save();
        continue;
      }
      let screened: Assessment | undefined;
      if (set.autoScreen) {
        const sc = await this.screen(c, set);
        if (!sc.ok) {
          log.info(`skip ${c.symbol}: ${sc.reason}`);
          if (!sc.error) {
            this.state.cooldowns[c.token] = Date.now() + set.autoCooldownHours * 3_600_000;
            this.save();
          }
          continue;
        }
        screened = sc.assessment;
      }
      try {
        const plan = await this.lp.plan(c.pool, size, set.autoMode);
        const { rec } = await this.lp.open(plan);
        rec.auto = true;
        this.lp.book.put(rec);
        this.state.spentWei = (this.spentToday() + BigInt(rec.depositQuote)).toString();
        this.save();
        await this.notify(
          `🤖 Auto-opened <b>#${esc(rec.id)}</b> ${esc(c.symbol)} ${feeTier(c.fee)} · ${eth(BigInt(rec.depositQuote))} ETH · ${set.autoMode}\n` +
            `measured fee APR ${c.aprEmaPct.toFixed(0)}% · depth ${eth(c.depthWei, 2)} ETH${this.lp.paper ? " <i>[paper]</i>" : ""}` +
            (screened ? `\nscreen (${esc(screened.source)}): copycat ${pct0(screened.copycat)} · rug signs ${pct0(screened.rugSigns)} · risk ${pct0(screened.risk)}` : ""),
        );
      } catch (e) {
        log.warn(`open ${c.symbol} failed: ${shortErr(e)}`);
        this.state.cooldowns[c.token] = Date.now() + set.autoCooldownHours * 3_600_000;
        this.save();
      }
      return; // at most one open per tick
    }
  }

  private async rotateOut() {
    const set = this.settings();
    const now = Date.now();
    for (const rec of this.autoPositions()) {
      const ageMin = (now - rec.openedAt) / 60_000;
      let reason: string | null = null;
      const c = this.scanner.get(rec.pool);
      if (set.autoCloseOorMin > 0 && rec.outOfRangeSince && now - rec.outOfRangeSince >= set.autoCloseOorMin * 60_000) {
        reason = "out of range too long";
      } else if (set.autoExitAprPct > 0 && ageMin >= set.autoGraceMin && c && c.samples >= 2 && c.aprEmaPct < set.autoExitAprPct) {
        reason = `yield faded to ${c.aprEmaPct.toFixed(0)}% APR`;
      }
      if (!reason) continue;
      try {
        const { closed } = await this.lp.close(rec.id, `auto: ${reason}`);
        this.state.cooldowns[rec.token] = now + set.autoCooldownHours * 3_600_000;
        this.save();
        await this.notify(`🤖 Auto-closed #${esc(rec.id)} ${esc(rec.symbol)}: ${esc(reason)}\nPnL ${signedEth(BigInt(closed.pnlQuote))} ETH (${pct(closed.pnlPct)})`);
      } catch (e) {
        log.warn(`close #${rec.id} failed: ${shortErr(e)}`);
      }
    }
  }

  /** Once per UTC day: yesterday's realized result + what's open now. */
  private async maybeReport() {
    const today = day();
    if (this.state.lastReportDay === today) return;
    const yesterday = this.state.lastReportDay;
    this.state.lastReportDay = today;
    this.save();
    if (!this.settings().dailyReport) return;
    const closed = this.lp.book.closed().filter((r) => day(r.closedAt) === yesterday);
    const pnl = closed.reduce((a, r) => a + BigInt(r.pnlQuote), 0n);
    const fees = closed.reduce((a, r) => a + BigInt(r.feesQuote), 0n);
    const wins = closed.filter((r) => BigInt(r.pnlQuote) > 0n).length;
    const open = this.lp.book.open();
    await this.notify(
      `📊 <b>Daily report</b> ${yesterday}${this.lp.paper ? " <i>[paper]</i>" : ""}\n` +
        `closed ${closed.length} (${wins} wins) · PnL ${signedEth(pnl)} ETH · fees ${eth(fees)} ETH\n` +
        `open now: ${open.length} (${open.filter((r) => r.auto).length} auto) · autopilot ${this.settings().autoEnabled ? "ON" : "off"}`,
    );
  }
}
