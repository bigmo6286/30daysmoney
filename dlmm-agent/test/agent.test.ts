import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/config";
import { PaperExecutor, type PoolReader, type PoolSnapshot } from "../src/chain/dlmm";
import { parsePool, type Pool } from "../src/auto/discovery";
import { Agent } from "../src/auto/agent";
import type { GateResult, Gates } from "../src/auto/gates";
import type { Screener } from "../src/auto/jev";
import { PositionBook } from "../src/positions";
import { Handlers } from "../src/bot/handlers";
import { rawPool } from "./fixtures";

class FakePools implements PoolReader {
  snaps = new Map<string, PoolSnapshot>();
  async read(pool: string) {
    const s = this.snaps.get(pool);
    if (!s) throw new Error(`unknown pool ${pool}`);
    return { ...s };
  }
  move(pool: string, activeId: number) {
    this.snaps.get(pool)!.activeId = activeId;
  }
}

const screener: Screener = { name: "fake", assess: async () => ({ copycat: 0, rugSigns: 0, risk: 0, source: "fake" }) };

function setup(gate: (p: Pool) => GateResult = () => ({ ok: true, roundTripLossPct: 1 }), opts: { screener?: Screener | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlmm-"));
  const settings = new SettingsStore(dir);
  const pools = new FakePools();
  const listed = [rawPool({ fee_active_tvl_ratio: 2 }, "AAA", "MintA"), rawPool({ fee_active_tvl_ratio: 1 }, "BBB", "MintB")].map((r) => parsePool(r)!);
  for (const p of listed) pools.snaps.set(p.address, { activeId: 1000, binStep: 100, solIsX: false, mint: p.mint, decimals: 6, tokenPriceSol: 0.001 });
  const checked: string[] = [];
  const gates: Gates = {
    screener: opts.screener === null ? undefined : (opts.screener ?? screener),
    check: async (p) => (checked.push(p.symbol), gate(p)),
  };
  const sent: string[] = [];
  const book = new PositionBook(dir);
  const agent = new Agent({
    exec: new PaperExecutor(pools),
    pools,
    gates,
    discover: async () => listed,
    book,
    settings: () => settings.value,
    notify: async (t) => sent.push(t),
    balanceSol: null,
    dataDir: dir,
  });
  const due = async () => {
    agent.lastScanAt = 0;
    await agent.tick();
  };
  return { agent, settings, pools, book, sent, checked, listed, due, dir, state: (a: Agent) => a.state };
}

describe("agent", () => {
  it("scans without opening while off, then opens the best pool, then stops out", async () => {
    const { agent, settings, pools, book, sent, due } = setup();
    await due();
    expect(agent.ranked.map((r) => r.pool.symbol)).toEqual(["AAA", "BBB"]);
    expect(book.open()).toHaveLength(0);

    settings.set("autoEnabled", "on");
    await due();
    expect(book.open()).toHaveLength(1);
    const rec = book.open()[0]!;
    expect(rec).toMatchObject({ symbol: "AAA", auto: true, entryId: 1000, minBinId: 948, maxBinId: 1000, bins: 52, depositSol: 0.1 });
    expect(sent.at(-1)).toContain("Auto-opened");
    expect(sent.at(-1)).toContain("[paper]");

    // token falls 30 bins (−26%): the range bought on the way down, so the loss (~8%) is under the stop
    pools.move(rec.pool, 970);
    await agent.tick();
    expect(book.open()).toHaveLength(1);
    // falls through the whole range (−63%): stop loss
    pools.move(rec.pool, 900);
    await agent.tick();
    expect(book.open()).toHaveLength(0);
    const closed = book.closed()[0]!;
    expect(closed.reason).toMatch(/stop loss/);
    expect(closed.pnlSol).toBeLessThan(-0.015);
    expect(sent.at(-1)).toContain("Auto-closed");
    expect(agent.state.cooldowns["MintA"]).toBeGreaterThan(Date.now());

    // AAA cools down, so the next scan takes BBB
    await due();
    expect(book.open().map((r) => r.symbol)).toEqual(["BBB"]);
  });

  it("closes a position that went above its range, after the timer", async () => {
    const { agent, settings, pools, book, due } = setup();
    settings.set("autoEnabled", "on");
    settings.set("minAgeMin", "0");
    settings.set("oorAboveMin", "0");
    await due();
    const rec = book.open()[0]!;
    pools.move(rec.pool, 1003);
    await agent.tick();
    expect(book.closed()[0]!.reason).toMatch(/above range/);
    expect(book.closed()[0]!.pnlSol).toBeCloseTo(0, 9); // above range = untouched SOL
  });

  it("respects max open and the daily budget", async () => {
    const a = setup();
    a.settings.set("autoEnabled", "on");
    a.settings.set("maxOpen", "1");
    await a.due();
    await a.due();
    expect(a.book.open()).toHaveLength(1);

    const b = setup();
    b.settings.set("autoEnabled", "on");
    b.settings.set("dailySol", "0.15"); // room for one 0.1 position
    await b.due();
    await b.due();
    expect(b.book.open()).toHaveLength(1);
  });

  it("cools down a token the gates reject, but not on a gate error", async () => {
    const r = setup((p) => (p.symbol === "AAA" ? { ok: false, reason: "rug signs 90%" } : { ok: false, error: true, reason: "RPC down" }));
    r.settings.set("autoEnabled", "on");
    await r.due();
    expect(r.book.open()).toHaveLength(0);
    expect(r.state(r.agent).cooldowns["MintA"]).toBeGreaterThan(Date.now());
    expect(r.state(r.agent).cooldowns["MintB"]).toBeUndefined();
    await r.due();
    expect(r.checked).toEqual(["AAA", "BBB", "BBB"]);
  });

  it("won't open with screening on and no screener, and says so once", async () => {
    const r = setup(undefined, { screener: null });
    r.settings.set("autoEnabled", "on");
    await r.due();
    await r.due();
    expect(r.book.open()).toHaveLength(0);
    expect(r.sent.filter((t) => t.includes("TYPESAFE_API_KEY"))).toHaveLength(1);
    r.settings.set("screen", "off");
    await r.due();
    expect(r.book.open()).toHaveLength(1);
  });

  it("estimates paper fees only while in range", async () => {
    const { agent, settings, pools, book, due } = setup();
    settings.set("autoEnabled", "on");
    await due();
    const rec = book.open()[0]!;
    rec.openedAt -= 4 * 3_600_000; // a whole 4h window at 2% fee/TVL
    rec.paper = { feesSol: 0, at: rec.openedAt };
    const st = await agent.status(rec, settings.value);
    expect(st.feesSol).toBeCloseTo(0.1 * 0.02, 5);
    pools.move(rec.pool, 1010); // above range
    rec.paper!.at -= 4 * 3_600_000;
    const st2 = await agent.status(rec, settings.value);
    expect(st2.feesSol).toBeCloseTo(st.feesSol, 6);
  });
});

describe("telegram", () => {
  it("/scan, /open → confirm, /status, /close → confirm", async () => {
    const r = setup();
    const out: { text: string; kb?: any }[] = [];
    const tg = { ownerId: "1", send: async (text: string, kb?: any) => (out.push({ text, kb }), { message_id: out.length }), edit: async () => {}, answer: async () => {} };
    const h = new Handlers(tg as any, r.agent, r.book, r.settings, { address: "Wallet111", balanceSol: async () => 1.5 });
    const say = (text: string) => h.handle({ chatId: "1", fromId: "1", text });
    const tap = (data: string) => h.handle({ chatId: "1", fromId: "1", callback: { id: "x", data, messageId: 1 } });

    await say("/scan");
    expect(out.at(-1)!.text).toContain("Top pools");
    expect(out.at(-1)!.text).toContain("AAA");
    await say("/open MintB 0.2");
    expect(out.at(-1)!.text).toContain("passes every gate");
    const btn = out.at(-1)!.kb[0][0].data as string;
    expect(btn).toBe(`o:${r.listed[1]!.address}:0.2`);
    await tap(btn);
    expect(r.book.open()).toMatchObject([{ symbol: "BBB", depositSol: 0.2, auto: false }]);
    await say("/status");
    expect(out.at(-1)!.text).toContain("#1 BBB");
    expect(out.at(-1)!.text).toContain("in range");
    await say("/close 1");
    await tap(out.at(-1)!.kb[0][0].data);
    expect(r.book.open()).toHaveLength(0);
    await say("/history");
    expect(out.at(-1)!.text).toContain("manual");
    await say("/set stopLossPct 20");
    expect(r.settings.value.stopLossPct).toBe(20);
    await say("/set nope 1");
    expect(out.at(-1)!.text).toContain("unknown setting");
  });

  it("/preset lists, switches with a diff, keeps sizing and the safety floors", async () => {
    const r = setup();
    r.settings.set("sizeSol", "0.25");
    const out: string[] = [];
    const tg = { ownerId: "1", send: async (text: string) => (out.push(text), { message_id: out.length }), edit: async () => {}, answer: async () => {} };
    const h = new Handlers(tg as any, r.agent, r.book, r.settings, { address: "Wallet111", balanceSol: async () => 1.5 });
    const say = (text: string) => h.handle({ chatId: "1", fromId: "1", text });
    await say("/preset");
    expect(out.at(-1)).toContain("now: balanced");
    await say("/preset safe");
    expect(out.at(-1)).toContain("stopLossPct: 15 → 10");
    expect(r.settings.value).toMatchObject({ stopLossPct: 10, minTokenAgeHours: 24, sizeSol: 0.25 });
    await say("/preset");
    expect(out.at(-1)).toContain("now: safe");
    r.settings.set("minHolders", "999");
    await say("/preset");
    expect(out.at(-1)).toContain("now: custom");
    await say("/preset balanced");
    expect(r.settings.value).toMatchObject({ stopLossPct: 15, minHolders: 500, sizeSol: 0.25 });
    await say("/preset balanced");
    expect(out.at(-1)).toContain("already set");
  });
});

describe("presets", () => {
  it("every preset keeps the stop loss on, mint renounced, Jev on, and never loosens the rug screen", async () => {
    const { PRESETS, SettingsSchema } = await import("../src/config");
    const d = SettingsSchema.parse({});
    for (const p of Object.values(PRESETS)) {
      const s = SettingsSchema.parse({ ...d, ...p.values });
      expect(s.stopLossPct).toBeGreaterThan(0);
      expect(s.requireMintRenounced).toBe(true);
      expect(s.screen).toBe(true);
      expect(s.maxRugPct).toBeLessThanOrEqual(d.maxRugPct);
      expect(s.sizeSol).toBe(d.sizeSol);
    }
  });
});
