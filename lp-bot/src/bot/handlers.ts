/** Telegram conversation: paste a token → pick pool → amount → mode → confirm. Plus management commands. */
import { ethers } from "ethers";
import type { Telegram, Incoming, Keyboard } from "./telegram";
import type { LpService, OpenPlan, PositionStatus, TxSummary } from "../lp/service";
import { readPoolView, type PoolView } from "../chain/pools";
import type { Autopilot } from "../auto/autopilot";
import type { SettingsStore } from "../config";
import { age, esc, eth, feeTier, pct, price, signedEth } from "../core/format";
import { shortErr } from "../chain/client";

interface Draft {
  pools: PoolView[];
  pool?: PoolView;
  amountWei?: bigint;
  plans?: Partial<Record<"single" | "inrange", OpenPlan>>;
  chosen?: OpenPlan;
  awaitingAmount?: boolean;
}

const HELP = `<b>LP Bot</b>
Paste a token address to open a position.

/list: open positions + PnL
/history: closed positions
/wallet: balances
/settings, /set &lt;key&gt; &lt;value&gt;
/close &lt;id&gt; · /collect &lt;id&gt; · /rebalance &lt;id&gt;
/closeall: close every position

/scan: best pools right now (measured fee yield)
/auto: autopilot status · /auto on|off · /auto block &lt;token&gt;
/screen &lt;token&gt;: Jev risk check (copycat, rug signs, risk)`;

export class Handlers {
  private draft: Draft | null = null;

  constructor(
    private readonly tg: Telegram,
    private readonly lp: LpService,
    private readonly settings: SettingsStore,
    private readonly auto?: Autopilot,
  ) {}

  private get tag() {
    return this.lp.paper ? " <i>[paper]</i>" : "";
  }

  async handle(m: Incoming): Promise<void> {
    try {
      if (m.callback) {
        await this.tg.answer(m.callback.id);
        await this.onButton(m.callback.data, m.callback.messageId);
      } else if (m.text) {
        await this.onText(m.text.trim());
      }
    } catch (e) {
      await this.tg.send(`⚠️ ${esc(shortErr(e))}`);
    }
  }

  private async onText(text: string) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase().replace(/@.*$/, "");
    if (ethers.isAddress(text)) return this.startOpen(text);
    if (this.draft?.awaitingAmount && /^\d*\.?\d+$/.test(text)) return this.onAmount(text);
    switch (cmd) {
      case "/start":
      case "/help":
        return void (await this.tg.send(`${HELP}\n\nMode: <b>${this.lp.paper ? "PAPER (no real transactions)" : "LIVE"}</b> · ${esc(this.lp.chain.cfg.chain.name)}`));
      case "/list":
        return this.list();
      case "/history":
        return this.history();
      case "/wallet":
        return this.wallet();
      case "/settings":
        return this.showSettings();
      case "/set": {
        const [k, v] = args;
        if (!k || v === undefined) return void (await this.tg.send("usage: /set &lt;key&gt; &lt;value&gt;"));
        const val = this.settings.set(k, v);
        return void (await this.tg.send(`✅ ${esc(k)} = <code>${esc(JSON.stringify(val))}</code>`));
      }
      case "/close":
        return this.confirm("close", args[0]);
      case "/collect":
        return args[0] ? this.collect(args[0]) : void (await this.tg.send("usage: /collect &lt;id&gt;"));
      case "/rebalance":
        return this.confirm("rebalance", args[0]);
      case "/scan":
        return this.scan();
      case "/auto":
        return this.autoCmd(args);
      case "/screen":
        return this.screenCmd(args[0]);
      case "/closeall":
        return void (await this.tg.send(`Close <b>all ${this.lp.book.open().length}</b> positions?`, [[{ text: "✅ Close all", data: "ca" }, { text: "✖ Cancel", data: "x" }]]));
      default:
        await this.tg.send("Paste a token address, or /help.");
    }
  }

  private async startOpen(token: string) {
    const msg = await this.tg.send("🔎 Looking for ETH pools (v3 + v4)…");
    const pools = await this.lp.findPools(token);
    if (!pools.length) return void (await this.tg.edit(msg.message_id, "No ETH pool with liquidity on the configured fee tiers (v3 WETH pools, and v4 native-ETH pools without hooks)."));
    this.draft = { pools };
    const kb: Keyboard = pools.map((p, i) => [{ text: `${p.version === 4 ? "v4 " : "v3 "}${feeTier(p.fee)} · ${eth(p.quoteReserve, 3)} ETH depth`, data: `p:${i}` }]);
    kb.push([{ text: "✖ Cancel", data: "x" }]);
    const t = pools[0]!.token;
    const screen = await this.screenLine(token, pools[0]!);
    await this.tg.edit(msg.message_id, `<b>${esc(t.symbol)}</b> · price ${price(Number(pools[0]!.priceE18) / 1e18)} ETH${screen}\nPick a pool:`, kb);
  }

  /** One-line Jev verdict for the pool picker; empty when there's no screener or it fails. Never blocks a manual open. */
  private async screenLine(token: string, deepest: PoolView): Promise<string> {
    if (!this.auto?.screener) return "";
    const r = await this.auto.screenToken(token, deepest).catch(() => undefined);
    const a = r?.assessment;
    if (!r || !a) return "";
    const p = (x: number) => `${(x * 100).toFixed(0)}%`;
    return `\n${r.ok ? "🧪✅" : "🧪⚠️"} copycat ${p(a.copycat)} · rug signs ${p(a.rugSigns)} · risk ${p(a.risk)}${r.ok ? "" : ` · <b>autopilot would skip: ${esc(r.reason ?? "")}</b>`}`;
  }

  private async onAmount(text: string) {
    const d = this.draft!;
    d.awaitingAmount = false;
    d.amountWei = ethers.parseEther(text);
    const pool = d.pool!;
    const [single, inrange] = await Promise.all([
      this.lp.plan(pool.address, d.amountWei, "single"),
      this.lp.plan(pool.address, d.amountWei, "inrange").catch(() => undefined),
    ]);
    d.plans = { single, inrange };
    const lines = [
      `<b>${esc(pool.token.symbol)}</b> · ${feeTier(pool.fee)} · ${eth(d.amountWei)} ETH${this.tag}`,
      "",
      `🛡 <b>Single-side</b>: range ${price(single.priceLower)} → ${price(single.priceUpper)}`,
      "   100% ETH, buys the token only if the price dips into range. Fees start when it does.",
    ];
    if (inrange) {
      lines.push(
        "",
        `🎯 <b>In-range</b>: range ${price(inrange.priceLower)} → ${price(inrange.priceUpper)}`,
        `   swaps ${eth(inrange.swapInWei)} ETH → ${esc(pool.token.symbol)} first. Fees start immediately; you carry token risk.`,
      );
    }
    const kb: Keyboard = [[{ text: "🛡 Single-side", data: "m:single" }]];
    if (inrange) kb[0]!.push({ text: "🎯 In-range", data: "m:inrange" });
    kb.push([{ text: "✖ Cancel", data: "x" }]);
    await this.tg.send(lines.join("\n"), kb);
  }

  private async onButton(data: string, messageId: number) {
    const [kind, arg] = data.split(":");
    switch (kind) {
      case "x":
        this.draft = null;
        return void (await this.tg.edit(messageId, "Cancelled."));
      case "p": {
        const pool = this.draft?.pools[Number(arg)];
        if (!pool) return void (await this.tg.edit(messageId, "Expired, paste the token again."));
        this.draft!.pool = pool;
        this.draft!.awaitingAmount = true;
        return void (await this.tg.edit(messageId, `<b>${esc(pool.token.symbol)}</b> · ${feeTier(pool.fee)} pool\nHow much ETH? (e.g. <code>0.05</code>)`));
      }
      case "m": {
        const plan = this.draft?.plans?.[arg as "single" | "inrange"];
        if (!plan) return void (await this.tg.edit(messageId, "Expired, paste the token again."));
        this.draft!.chosen = plan;
        const text = [
          `Confirm${this.tag}`,
          `<b>${esc(plan.pool.token.symbol)}</b> ${feeTier(plan.pool.fee)} · ${plan.mode === "single" ? "🛡 single-side" : "🎯 in-range"}`,
          `amount ${eth(plan.amountWei)} ETH · slippage ${this.settings.value.slippagePct}%`,
          `range ${price(plan.priceLower)} → ${price(plan.priceUpper)} ETH`,
          "Every transaction is simulated before it is sent.",
        ].join("\n");
        return void (await this.tg.edit(messageId, text, [[{ text: "✅ Open", data: "go" }, { text: "✖ Cancel", data: "x" }]]));
      }
      case "go": {
        const plan = this.draft?.chosen;
        this.draft = null;
        if (!plan) return void (await this.tg.edit(messageId, "Expired, paste the token again."));
        await this.tg.edit(messageId, "⏳ Opening…");
        const { rec, txs } = await this.lp.open(plan);
        return void (await this.tg.edit(messageId, `✅ Opened <b>#${rec.id}</b> ${esc(rec.symbol)}${this.tag}\ndeposit ${eth(BigInt(rec.depositQuote))} ETH${this.txLinks(txs)}`, [[{ text: "📋 Positions", data: "ref" }]]));
      }
      case "ref":
        return this.list();
      case "o": {
        const pool = await readPoolView(this.lp.chain, arg!);
        this.draft = { pools: [pool], pool, awaitingAmount: true };
        return void (await this.tg.send(`<b>${esc(pool.token.symbol)}</b> · ${feeTier(pool.fee)} pool\nHow much ETH? (e.g. <code>0.05</code>)`));
      }
      case "c":
      case "r":
        return this.confirm(kind === "c" ? "close" : "rebalance", arg);
      case "cc":
        return this.close(arg!, messageId);
      case "rr":
        return this.rebalance(arg!, messageId);
      case "f":
        return this.collect(arg!);
      case "ca":
        return this.closeAll(messageId);
    }
  }

  private async confirm(what: "close" | "rebalance", id?: string) {
    if (!id || !this.lp.book.get(id)) return void (await this.tg.send(`usage: /${what} &lt;id&gt; (see /list)`));
    const verb = what === "close" ? "Close" : "Rebalance (close + reopen around current price)";
    await this.tg.send(`${verb} <b>#${esc(id)}</b>?`, [[{ text: "✅ Yes", data: `${what === "close" ? "cc" : "rr"}:${id}` }, { text: "✖ Cancel", data: "x" }]]);
  }

  private txLinks(txs: TxSummary[]): string {
    return txs.length ? "\n" + txs.map((t) => `<a href="${this.lp.chain.explorerTx(t.hash)}">${t.label}</a>`).join(" · ") : "";
  }

  renderStatus(s: PositionStatus): string {
    const r = s.rec;
    const now = Number(s.pool.priceE18) / 1e18;
    const lo = this.lp.priceAtTick(s.pool, r.tickLower);
    const hi = this.lp.priceAtTick(s.pool, r.tickUpper);
    const ms = Date.now() - r.openedAt;
    const perHour = ms > 60_000 ? (s.pnl.feesQuote * 3_600_000n) / BigInt(ms) : 0n;
    return [
      `${s.inRange ? "🟢" : "🔴"} <b>${esc(r.symbol)}</b> · ${r.version === 4 ? "v4 " : ""}${feeTier(r.fee)} · #${esc(r.id)}${r.kind === "paper" ? " <i>paper</i>" : ""}`,
      `   value ${eth(s.pnl.valueQuote)} ETH · fees ${eth(s.pnl.feesQuote)}${r.kind === "paper" ? " (est.)" : ""}`,
      `   PnL ${signedEth(s.pnl.pnlQuote)} (${pct(s.pnl.pnlPct)}) · vs HODL ${signedEth(s.pnl.vsHodlQuote)}`,
      `   range ${price(Math.min(lo, hi))} → ${price(Math.max(lo, hi))} · now ${price(now)}`,
      `   age ${age(ms)} · ${eth(perHour, 6)} ETH/h in fees`,
    ].join("\n");
  }

  async list() {
    const recs = this.lp.book.open();
    if (!recs.length) return void (await this.tg.send(`No open positions${this.tag}. Paste a token address to open one.`));
    const statuses = await Promise.all(recs.map((r) => this.lp.status(r).catch((e) => e as Error)));
    let total = 0n;
    let pnl = 0n;
    const blocks: string[] = [];
    const kb: Keyboard = [];
    statuses.forEach((s, i) => {
      const id = recs[i]!.id;
      if (s instanceof Error) {
        blocks.push(`⚠️ #${esc(id)} ${esc(recs[i]!.symbol)}: ${esc(shortErr(s))}`);
      } else {
        total += s.pnl.valueQuote;
        pnl += s.pnl.pnlQuote;
        blocks.push(this.renderStatus(s));
        this.lp.book.put(s.rec);
      }
      kb.push([
        { text: `✖ Close #${id}`, data: `c:${id}` },
        { text: `💰 Fees`, data: `f:${id}` },
        { text: `🔄 Rebalance`, data: `r:${id}` },
      ]);
    });
    kb.push([{ text: "🔄 Refresh", data: "ref" }]);
    await this.tg.send(`📋 <b>Positions</b>${this.tag}\n\n${blocks.join("\n\n")}\n\n<b>TOTAL</b> ${eth(total)} ETH · PnL ${signedEth(pnl)}`, kb);
  }

  private async scan() {
    if (!this.auto) return;
    const sc = this.auto.scanner;
    if (!sc.lastScanAt) await this.tg.send("🔎 First scan: reading the last hour of swaps to find active pools…");
    const rows = sc.lastScanAt ? sc.ranked() : await sc.scan();
    const set = this.settings.value;
    const ready = rows.filter((c) => c.samples >= 1).slice(0, 8);
    if (!ready.length) {
      return void (await this.tg.send(`Tracking ${sc.indexedCount} active WETH pools. Yield needs two readings: check /scan again in ~${set.autoScanMin} min.`));
    }
    const lines = ready.map((c, i) => {
      const g = this.auto!.gate(c, set);
      const sc = this.auto!.cachedScreen(c.token, set);
      const screen = !sc ? "" : sc.ok ? " 🧪✅" : ` 🧪🚫 <i>${esc(sc.reason ?? "")}</i>`;
      return `${i + 1}. <b>${esc(c.symbol)}</b> ${feeTier(c.fee)} · APR ${c.aprEmaPct.toFixed(0)}% · depth ${eth(c.depthWei, 2)} · ${c.swaps} swaps · move ${pct(c.movePct)}${g.ok ? " ✅" : ` <i>(${esc(g.reason ?? "")})</i>`}${screen}`;
    });
    const kb: Keyboard = ready.slice(0, 4).map((c) => [{ text: `🎯 LP ${c.symbol} ${feeTier(c.fee)}`, data: `o:${c.pool}` }]);
    await this.tg.send(
      `🔎 <b>Top pools</b> · fee APR measured for a ${set.autoSizeEth} ETH position at ±${set.widthPct}%\n\n${lines.join("\n")}\n\n✅ = passes the autopilot gates · 🧪 = Jev screen (cached)`,
      kb,
    );
  }

  private async screenCmd(arg?: string) {
    if (!this.auto) return;
    if (!arg || !ethers.isAddress(arg)) return void (await this.tg.send("usage: /screen &lt;token address&gt;"));
    if (!this.auto.screener) return void (await this.tg.send("No screener: set <code>TYPESAFE_API_KEY</code> in .env and restart."));
    const msg = await this.tg.send("🧪 Screening…");
    const r = await this.auto.screenToken(arg);
    if (!r.assessment) return void (await this.tg.edit(msg.message_id, `⚠️ ${esc(r.symbol)}: ${esc(r.reason ?? "screen failed")}`));
    const a = r.assessment;
    const f = r.facts;
    const p = (x: number) => `${(x * 100).toFixed(0)}%`;
    const lines = [
      `🧪 <b>${esc(r.symbol)}</b> · ${esc(a.source)}`,
      `copycat ${p(a.copycat)} · rug signs ${p(a.rugSigns)} · risk ${p(a.risk)}`,
      r.ok ? "✅ passes the autopilot thresholds" : `🚫 autopilot would skip: ${esc(r.reason ?? "")}`,
    ];
    if (f) {
      lines.push(
        "",
        `owner: ${f.owner === "renounced" || f.owner === "none" ? f.owner : `<code>${esc(f.owner)}</code>`}${f.upgradeableProxy ? " · upgradeable proxy" : ""} · ${f.supplyInPoolPct}% of supply in pool`,
        `admin functions: ${f.adminFunctions.length ? esc(f.adminFunctions.map((s) => s.split("(")[0]).join(", ")) : "none found"}`,
      );
    }
    await this.tg.edit(msg.message_id, lines.join("\n"));
  }

  private async autoCmd(args: string[]) {
    if (!this.auto) return;
    const [sub, arg] = args;
    if (sub === "on" || sub === "off") this.settings.set("autoEnabled", sub);
    if (sub === "block" && arg && ethers.isAddress(arg)) {
      this.auto.block(arg);
      return void (await this.tg.send(`🚫 ${esc(arg)} will never be auto-opened.`));
    }
    const s = this.settings.value;
    const open = this.auto.autoPositions();
    await this.tg.send(
      [
        `🤖 <b>Autopilot ${s.autoEnabled ? "ON" : "OFF"}</b>${this.tag}`,
        `size ${s.autoSizeEth} ETH · max open ${s.autoMaxOpen} (now ${open.length}) · ${s.autoMode}`,
        `budget ${eth(this.auto.spentToday())} / ${s.autoDailyEth} ETH today`,
        `opens when: APR ≥ ${s.autoMinAprPct}% · depth ≥ ${s.autoMinDepthEth} ETH · move ≤ ${s.autoMaxMovePct}% · round-trip check`,
        `screening: ${!s.autoScreen ? "off" : this.auto.screener ? `${esc(this.auto.screener.name)} · block if copycat > ${s.autoMaxCopycatPct}% · rug signs > ${s.autoMaxRugPct}% · risk > ${s.autoMaxRiskPct}%` : "on, but no TYPESAFE_API_KEY: nothing will open"}`,
        `closes when: out of range ${s.autoCloseOorMin}m · APR < ${s.autoExitAprPct}% after ${s.autoGraceMin}m${s.tpPct ? ` · TP ${s.tpPct}%` : ""}${s.slPct ? ` · SL ${s.slPct}%` : ""}`,
        `scan every ${s.autoScanMin}m · ${this.auto.scanner.indexedCount} active pools tracked`,
        "",
        s.autoEnabled ? "Turn off: /auto off" : "Turn on: /auto on · tune with /set auto… (see /settings)",
      ].join("\n"),
    );
  }

  private async history() {
    const rows = this.lp.book.closed().slice(0, 15);
    if (!rows.length) return void (await this.tg.send("No closed positions yet."));
    const all = this.lp.book.closed();
    const wins = all.filter((r) => BigInt(r.pnlQuote) > 0n).length;
    const sum = all.reduce((a, r) => a + BigInt(r.pnlQuote), 0n);
    const lines = rows.map(
      (r) => `${BigInt(r.pnlQuote) >= 0n ? "✅" : "❌"} #${esc(r.id)} ${esc(r.symbol)} ${feeTier(r.fee)} · ${signedEth(BigInt(r.pnlQuote))} (${pct(r.pnlPct)}) · ${age(r.closedAt - r.openedAt)} · ${esc(r.reason)}`,
    );
    await this.tg.send(`📒 <b>History</b> · ${wins}/${all.length} wins · total ${signedEth(sum)} ETH\n\n${lines.join("\n")}`);
  }

  private async wallet() {
    const bal = await this.lp.chain.nativeBalance();
    await this.tg.send(`👛 <code>${this.lp.chain.address}</code>\n${eth(bal)} ETH on ${esc(this.lp.chain.cfg.chain.name)}${this.tag}`);
  }

  private async showSettings() {
    const rows = Object.entries(this.settings.value).map(([k, v]) => `${k} = <code>${esc(JSON.stringify(v))}</code>`);
    await this.tg.send(`⚙️ <b>Settings</b>\n${rows.join("\n")}\n\nChange with /set &lt;key&gt; &lt;value&gt;`);
  }

  private async close(id: string, messageId: number) {
    await this.tg.edit(messageId, `⏳ Closing #${esc(id)}…`);
    const { closed, txs } = await this.lp.close(id);
    await this.tg.edit(messageId, `✅ Closed #${esc(id)} ${esc(closed.symbol)}\nreturned ${eth(BigInt(closed.realizedQuote))} ETH · PnL ${signedEth(BigInt(closed.pnlQuote))} (${pct(closed.pnlPct)})${this.txLinks(txs)}`);
  }

  private async rebalance(id: string, messageId: number) {
    await this.tg.edit(messageId, `⏳ Rebalancing #${esc(id)}…`);
    const { closed, rec, txs } = await this.lp.rebalance(id);
    await this.tg.edit(messageId, `🔄 #${esc(id)} → <b>#${esc(rec.id)}</b> ${esc(rec.symbol)}\nclosed at ${signedEth(BigInt(closed.pnlQuote))} ETH, reopened with ${eth(BigInt(rec.depositQuote))} ETH${this.txLinks(txs)}`);
  }

  private async collect(id: string) {
    const { feesQuote, txs } = await this.lp.collect(id);
    await this.tg.send(`💰 Collected ≈${eth(feesQuote)} ETH in fees from #${esc(id)}${this.txLinks(txs)}`);
  }

  private async closeAll(messageId: number) {
    const ids = this.lp.book.open().map((r) => r.id);
    await this.tg.edit(messageId, `⏳ Closing ${ids.length} positions…`);
    const out: string[] = [];
    for (const id of ids) {
      try {
        const { closed } = await this.lp.close(id, "close-all");
        out.push(`✅ #${esc(id)} ${signedEth(BigInt(closed.pnlQuote))}`);
      } catch (e) {
        out.push(`⚠️ #${esc(id)} ${esc(shortErr(e))}`);
      }
    }
    await this.tg.edit(messageId, out.join("\n") || "Nothing to close.");
  }
}
