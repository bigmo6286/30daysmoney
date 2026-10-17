/**
 * Background loop: range alerts, take-profit / stop-loss, auto-rebalance, paper fee accrual.
 */
import type { LpService } from "./lp/service";
import type { Telegram } from "./bot/telegram";
import type { Handlers } from "./bot/handlers";
import { esc, pct, signedEth } from "./core/format";
import { shortErr } from "./chain/client";
import { logger } from "./log";

const log = logger("monitor");

export class Monitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly lp: LpService,
    private readonly tg: Telegram,
    private readonly handlers: Handlers,
  ) {}

  start() {
    const loop = async () => {
      await this.tick();
      this.timer = setTimeout(loop, this.lp.settings().monitorSec * 1000);
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
      for (const rec of this.lp.book.open()) {
        try {
          await this.check(rec.id);
        } catch (e) {
          log.warn(`#${rec.id}: ${shortErr(e)}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(id: string) {
    const rec = this.lp.book.get(id);
    if (!rec) return;
    const s = this.lp.status(rec);
    const st = await s;
    const set = this.lp.settings();
    const now = Date.now();
    const was = rec.inRange;
    rec.inRange = st.inRange;
    if (st.inRange) delete rec.outOfRangeSince;
    else rec.outOfRangeSince ??= now;
    this.lp.book.put(rec);

    if (set.alertOutOfRange && was !== undefined && was !== st.inRange) {
      await this.tg.send(`${st.inRange ? "🟢 Back in range" : "🔴 Out of range"}: #${esc(id)}\n\n${this.handlers.renderStatus(st)}`);
    }
    if (set.tpPct > 0 && st.pnl.pnlPct >= set.tpPct) return this.autoClose(id, `take-profit ${pct(st.pnl.pnlPct)}`);
    if (set.slPct > 0 && st.pnl.pnlPct <= -set.slPct) return this.autoClose(id, `stop-loss ${pct(st.pnl.pnlPct)}`);
    if (set.autoRebalance && rec.outOfRangeSince && now - rec.outOfRangeSince >= set.rebalanceGraceMin * 60_000) {
      const { closed, rec: next } = await this.lp.rebalance(id, "auto-rebalance");
      await this.tg.send(`🔄 Auto-rebalanced #${esc(id)} → #${esc(next.id)} ${esc(next.symbol)} (closed at ${signedEth(BigInt(closed.pnlQuote))} ETH)`);
    }
  }

  private async autoClose(id: string, reason: string) {
    const { closed } = await this.lp.close(id, reason);
    await this.tg.send(`🤖 Auto-closed #${esc(id)} ${esc(closed.symbol)}: ${esc(reason)}\nPnL ${signedEth(BigInt(closed.pnlQuote))} ETH`);
  }
}
