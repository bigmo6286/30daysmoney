/** Telegram commands. Everything that moves funds asks for a button confirmation first. */
import type { Telegram, Incoming, Keyboard } from "./telegram";
import type { Agent } from "../auto/agent";
import type { Pool } from "../auto/discovery";
import type { GateResult } from "../auto/gates";
import type { SettingsStore } from "../config";
import type { PositionBook } from "../positions";
import { age, esc, pct, short, signedSol, sol, usd } from "../format";
import { shortErr } from "../chain/solana";

const HELP = `<b>DLMM Agent</b> · Meteora liquidity on Solana

/status: wallet, open positions, PnL
/history: closed positions
/scan: best pools right now
/check &lt;pool|mint&gt;: run every safety gate on one token
/open &lt;pool|mint&gt; [SOL]: open a position (asks to confirm)
/close &lt;id&gt; · /closeall
/auto: autopilot status · /auto on|off · /auto block &lt;mint&gt;
/settings · /set &lt;key&gt; &lt;value&gt;`;

export class Handlers {
  constructor(
    private readonly tg: Telegram,
    private readonly agent: Agent,
    private readonly book: PositionBook,
    private readonly settings: SettingsStore,
    private readonly wallet: { address: string; balanceSol: () => Promise<number> },
  ) {}

  private get tag() {
    return this.agent.paper ? " <i>[paper]</i>" : "";
  }

  async handle(m: Incoming): Promise<void> {
    try {
      if (m.callback) {
        await this.tg.answer(m.callback.id);
        return await this.onButton(m.callback.data);
      }
      if (m.text) return await this.onText(m.text.trim());
    } catch (e) {
      await this.tg.send(`⚠️ ${esc(shortErr(e))}`);
    }
  }

  private async onText(text: string) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase().replace(/@.*$/, "");
    switch (cmd) {
      case "/start":
      case "/help":
        return void (await this.tg.send(`${HELP}\n\nMode: <b>${this.agent.paper ? "PAPER (no real transactions)" : "LIVE"}</b>`));
      case "/status":
      case "/list":
        return this.status();
      case "/history":
        return this.history();
      case "/scan":
        return this.scan();
      case "/check":
        return this.check(args[0]);
      case "/open":
        return this.openCmd(args[0], args[1]);
      case "/close":
        return args[0] ? this.confirmClose(args[0]) : void (await this.tg.send("usage: /close &lt;id&gt;"));
      case "/closeall":
        return void (await this.tg.send(`Close <b>all ${this.book.open().length}</b> positions?`, [[{ text: "✅ Close all", data: "ca" }, { text: "✖ Cancel", data: "x" }]]));
      case "/auto":
        return this.autoCmd(args);
      case "/settings":
        return this.showSettings();
      case "/set": {
        const [k, v] = args;
        if (!k || v === undefined) return void (await this.tg.send("usage: /set &lt;key&gt; &lt;value&gt;"));
        const val = this.settings.set(k, v);
        return void (await this.tg.send(`✅ ${esc(k)} = <code>${esc(JSON.stringify(val))}</code>`));
      }
      default:
        await this.tg.send("Unknown command. /help");
    }
  }

  private async onButton(data: string) {
    const [kind, a, b] = data.split(":");
    if (kind === "x") return void (await this.tg.send("Cancelled."));
    if (kind === "c" && a) return this.closeOne(a);
    if (kind === "k" && a) return this.check(a);
    if (kind === "ca") {
      for (const r of [...this.book.open()]) await this.closeOne(r.id);
      return;
    }
    if (kind === "o" && a && b) {
      const p = this.agent.seen.get(a);
      if (!p) return void (await this.tg.send("That pool is no longer in the scan. /scan again."));
      await this.tg.send(`⏳ Opening ${esc(p.symbol)}…`);
      await this.agent.open(p, Number(b), this.settings.value, false);
    }
  }

  private async closeOne(id: string) {
    await this.tg.send(`⏳ Closing #${esc(id)}…`);
    await this.agent.close(id, "manual").catch(() => undefined); // the agent reports the result or the failure
  }

  private async status() {
    const s = this.settings.value;
    const open = this.book.open();
    const lines = [
      `👛 <code>${esc(this.wallet.address)}</code>${this.tag}`,
      `balance ${sol(await this.wallet.balanceSol().catch(() => NaN))} SOL · autopilot ${s.autoEnabled ? "ON" : "off"} · today ${sol(this.agent.spentToday())}/${s.dailySol} SOL`,
    ];
    if (!open.length) lines.push("", "No open positions.");
    for (const rec of open) {
      try {
        const st = await this.agent.status(rec, s);
        const rs = st.range === "in" ? "🟢 in range" : st.range === "above" ? `🔼 above range ${Math.round(st.oorMin)}m` : `🔽 below range ${Math.round(st.oorMin)}m`;
        lines.push(
          "",
          `<b>#${rec.id} ${esc(rec.symbol)}</b>${rec.auto ? " 🤖" : ""} · ${age(Date.now() - rec.openedAt)} · ${rs}`,
          `value ${sol(st.valueSol)} SOL (fees ${sol(st.feesSol)}) · PnL ${signedSol(st.pnlSol)} (${pct(st.pnlPct)}) · peak ${pct(rec.peakPnlPct)}`,
        );
      } catch (e) {
        lines.push("", `⚠️ #${rec.id} ${esc(rec.symbol)}: ${esc(shortErr(e))}`);
      }
    }
    const kb: Keyboard = open.map((r) => [{ text: `✖ Close #${r.id} ${r.symbol}`, data: `c:${r.id}` }]);
    await this.tg.send(lines.join("\n"), kb.length ? kb : undefined);
  }

  private async history() {
    const all = this.book.closed();
    if (!all.length) return void (await this.tg.send("No closed positions yet."));
    const sum = all.reduce((a, r) => a + r.pnlSol, 0);
    const wins = all.filter((r) => r.pnlSol > 0).length;
    const lines = all.slice(0, 15).map((r) => `#${r.id} ${esc(r.symbol)} · ${signedSol(r.pnlSol)} SOL (${pct(r.pnlPct)}) · ${age(r.closedAt - r.openedAt)} · ${esc(r.reason)}`);
    await this.tg.send(`📒 <b>History</b>${this.tag} · ${wins}/${all.length} wins · total ${signedSol(sum)} SOL\n\n${lines.join("\n")}`);
  }

  private async scan() {
    await this.tg.send("🔎 Scanning Meteora pools…");
    const s = this.settings.value;
    const ranked = await this.agent.scan(s);
    if (!ranked.length) {
      const why = this.agent.rejected.slice(0, 5).map((r) => `· ${esc(r.pool.symbol)}: ${esc(r.reason)}`);
      return void (await this.tg.send(`No pool passes screening (${this.agent.seen.size} seen).${why.length ? `\n${why.join("\n")}` : ""}`));
    }
    const top = ranked.slice(0, 8);
    const lines = top.map((c, i) => {
      const p = c.pool;
      const skip = this.agent.skipReason(p);
      const jev = this.agent.screener?.peek?.(p.mint);
      const j = jev ? ` · 🧪 ${(jev.risk * 100).toFixed(0)}% risk` : "";
      return `${i + 1}. <b>${esc(p.symbol)}</b> · fee/TVL ${p.feeTvlPct.toFixed(2)}% · TVL ${usd(p.tvlUsd)} · mcap ${usd(p.mcapUsd)} · bin ${p.binStep}${c.pvp ? " · ⚔️ PVP" : ""}${j}${skip ? ` <i>(${esc(skip)})</i>` : ""}`;
    });
    const kb: Keyboard = top.slice(0, 4).map((c) => [{ text: `🔍 Check ${c.pool.symbol}`, data: `k:${c.pool.address}` }]);
    await this.tg.send(`🔎 <b>Top pools</b> · ${s.timeframe} · ${ranked.length} of ${this.agent.seen.size} pass\n\n${lines.join("\n")}\n\n/check or /open a pool or mint for the full gates.`, kb);
  }

  private find(arg?: string): Pool | undefined {
    if (!arg) return undefined;
    return this.agent.seen.get(arg) ?? [...this.agent.seen.values()].find((p) => p.mint === arg);
  }

  private renderGates(p: Pool, g: GateResult): string {
    const f = g.facts;
    const a = g.assessment;
    const lines = [
      `${g.ok ? "✅" : g.error ? "⚠️" : "🚫"} <b>${esc(p.symbol)}</b> <code>${esc(short(p.mint))}</code> · ${g.ok ? "passes every gate" : esc(g.reason ?? "")}`,
    ];
    if (f) {
      lines.push(
        `mint authority ${f.mintAuthority ? "⚠️ live" : "revoked"} · freeze ${f.freezeAuthority ? "⚠️ live" : "revoked"} · ${f.program}${f.extensions.length ? ` (${esc(f.extensions.join(", "))})` : ""}`,
        `top 10 holders ${f.top10Pct === null ? "unknown (RPC)" : f.top10Pct.toFixed(1) + "%"} · in pool ${f.inPoolPct === null ? "unknown" : f.inPoolPct.toFixed(1) + "%"}`,
      );
    }
    if (g.roundTripLossPct !== undefined) lines.push(`round trip −${g.roundTripLossPct.toFixed(1)}%`);
    if (a) lines.push(`🧪 ${esc(a.source)}: copycat ${(a.copycat * 100).toFixed(0)}% · rug signs ${(a.rugSigns * 100).toFixed(0)}% · risk ${(a.risk * 100).toFixed(0)}%`);
    return lines.join("\n");
  }

  private async check(arg?: string) {
    const p = this.find(arg);
    if (!p) return void (await this.tg.send(arg ? "Not in the last scan. /scan first (only listed SOL DLMM pools can be checked)." : "usage: /check &lt;pool|mint&gt;"));
    const g = await this.agent.check(p, this.settings.value);
    await this.tg.send(this.renderGates(p, g));
  }

  private async openCmd(arg?: string, amount?: string) {
    const p = this.find(arg);
    if (!p) return void (await this.tg.send(arg ? "Not in the last scan. /scan first." : "usage: /open &lt;pool|mint&gt; [SOL]"));
    const s = this.settings.value;
    const size = amount ? Number(amount) : s.sizeSol;
    if (!(size > 0)) return void (await this.tg.send("Amount must be a positive number of SOL."));
    const g = await this.agent.check(p, { ...s, sizeSol: size });
    await this.tg.send(`${this.renderGates(p, g)}\n\nOpen <b>${sol(size)} SOL</b> single-sided, ${s.downsidePct}% downside range?${this.tag}`, [
      [{ text: g.ok ? "✅ Open" : "⚠️ Open anyway", data: `o:${p.address}:${size}` }, { text: "✖ Cancel", data: "x" }],
    ]);
  }

  private async confirmClose(id: string) {
    const rec = this.book.get(id);
    if (!rec) return void (await this.tg.send(`No open position #${esc(id)}.`));
    await this.tg.send(`Close #${esc(id)} ${esc(rec.symbol)}?`, [[{ text: "✅ Close", data: `c:${id}` }, { text: "✖ Cancel", data: "x" }]]);
  }

  private async autoCmd(args: string[]) {
    const [sub, arg] = args;
    if (sub === "on" || sub === "off") this.settings.set("autoEnabled", sub);
    if (sub === "block" && arg) {
      this.agent.block(arg);
      return void (await this.tg.send(`🚫 ${esc(arg)} will never be auto-opened.`));
    }
    const s = this.settings.value;
    const auto = this.book.open().filter((r) => r.auto).length;
    await this.tg.send(
      [
        `🤖 <b>Autopilot ${s.autoEnabled ? "ON" : "OFF"}</b>${this.tag}`,
        `size ${s.sizeSol} SOL · max open ${s.maxOpen} (now ${auto}) · today ${sol(this.agent.spentToday())}/${s.dailySol} SOL`,
        `screens: ${s.timeframe} · fee/TVL ≥ ${s.minFeeTvlPct}% · TVL ≥ ${usd(s.minTvlUsd)} · mcap ${usd(s.minMcapUsd)}-${usd(s.maxMcapUsd)} · organic ≥ ${s.minOrganic} · bin ${s.minBinStep}-${s.maxBinStep}`,
        `gates: authorities${s.requireMintRenounced ? " + mint" : ""} · top10 ≤ ${s.maxTop10Pct}% · round trip ≤ ${s.maxRoundTripLossPct}% · Jev ${!s.screen ? "off" : this.agent.screener ? `copycat ≤ ${s.maxCopycatPct}% rug ≤ ${s.maxRugPct}% risk ≤ ${s.maxRiskPct}%` : "on, but no TYPESAFE_API_KEY: nothing opens"}`,
        `exits: SL ${s.stopLossPct ? `−${s.stopLossPct}%` : "off"}${s.takeProfitPct ? ` · TP +${s.takeProfitPct}%` : ""}${s.trailArmPct ? ` · trail +${s.trailArmPct}%/−${s.trailDropPct}%` : ""} · above range ${s.oorAboveMin}m · below range ${s.oorBelowMin}m`,
        "",
        s.autoEnabled ? "Turn off: /auto off" : "Turn on: /auto on",
      ].join("\n"),
    );
  }

  private async showSettings() {
    const v = this.settings.value as Record<string, unknown>;
    await this.tg.send(`⚙️ <b>Settings</b>\n<code>${esc(Object.entries(v).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join("\n"))}</code>\n\n/set &lt;key&gt; &lt;value&gt;`);
  }
}
