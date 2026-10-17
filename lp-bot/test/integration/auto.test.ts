import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { startEnv, BOT_KEY, DEPLOYER_KEY, type TestEnv } from "./env";
import { compileTestContracts } from "./contracts";
import { loadConfig, SettingsStore } from "../../src/config";
import { Chain } from "../../src/chain/client";
import { PositionBook } from "../../src/lp/positions";
import { LpService } from "../../src/lp/service";
import { Scanner } from "../../src/auto/scanner";
import { Autopilot } from "../../src/auto/autopilot";
import { CachedScreener, type Assessment, type Screener } from "../../src/auto/screen";
import { Handlers } from "../../src/bot/handlers";
import type { TokenFacts } from "../../src/auto/facts";

/** stand-in for Jev: records the facts it was shown and returns a fixed assessment */
function fakeScreener(a: Partial<Assessment> = {}) {
  const seen: TokenFacts[] = [];
  const s: Screener = {
    name: "fake",
    assess: async (f) => (seen.push(f), { copycat: 0.05, rugSigns: 0.05, risk: 0.1, source: "fake", ...a }),
  };
  return { s, seen };
}

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

function setup(sub: string, screener?: Screener) {
  const dataDir = path.join(env.dataDir, sub);
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig({
    MODE: "paper", CHAIN: "custom", CHAIN_ID: "31337", RPC_URL: env.rpcUrl, WALLET_KEY: BOT_KEY,
    TG_TOKEN: "123456:test-token-test-token-test-token-xx", TG_OWNER_ID: "1", DATA_DIR: dataDir,
    V3_FACTORY: env.contracts.factory, V3_POSITION_MANAGER: env.contracts.positionManager,
    V3_SWAP_ROUTER02: env.contracts.swapRouter02, V3_QUOTER_V2: env.contracts.quoterV2, WETH: env.contracts.weth,
  });
  const chain = new Chain(cfg);
  const settings = new SettingsStore(dataDir);
  const lp = new LpService(chain, new PositionBook(dataDir), () => settings.value, true);
  const scanner = new Scanner(chain, () => settings.value, dataDir);
  const sent: string[] = [];
  const auto = new Autopilot(lp, scanner, () => settings.value, async (t) => sent.push(t), dataDir, screener);
  return { lp, settings, scanner, auto, sent };
}

/** generate fee-paying volume in both pools, then let wall-clock time pass for the yield window */
async function churn() {
  for (const m of env.markets) {
    await m.trade(3);
    await m.trade(-3);
  }
  await new Promise((r) => setTimeout(r, 31_000));
}

describe("scanner + autopilot", () => {
  it("discovers active pools from swaps, measures yield, auto-opens, then rotates out", async () => {
    const screen = fakeScreener();
    const { lp, settings, scanner, auto, sent } = setup("auto", screen.s);
    // a non-pool contract emitting a Swap-shaped log must be skipped, not abort the index
    const deployer = new ethers.Wallet(DEPLOYER_KEY, env.provider);
    const spamArt = compileTestContracts().SwapSpam;
    const spam = await new ethers.ContractFactory(spamArt.abi, spamArt.bytecode, deployer).deploy();
    await spam.waitForDeployment();
    await (await (spam as ethers.Contract).getFunction("spam")()).wait();
    await churn();
    await scanner.scan();
    expect(scanner.indexedCount).toBe(2);
    await churn();
    await scanner.scan();
    await churn();
    const ranked = await scanner.scan();
    expect(ranked).toHaveLength(2);
    expect(ranked.every((c) => c.samples >= 2 && c.aprEmaPct > 0)).toBe(true);

    // gates
    settings.set("autoMinAprPct", "1000000000");
    expect(auto.gate(ranked[0]!, settings.value)).toEqual({ ok: false, reason: expect.stringContaining("APR") });
    settings.set("autoMinAprPct", "0");
    settings.set("autoMaxMovePct", "100");
    expect(auto.gate(ranked[0]!, settings.value).ok).toBe(true);
    expect((await auto.roundTrip(ranked[0]!, 10n ** 16n)).ok).toBe(true);

    // off by default: a tick must not open anything
    await auto.tick();
    expect(lp.book.open()).toHaveLength(0);

    settings.set("autoEnabled", "on");
    settings.set("autoMaxOpen", "1");
    await auto.tick();
    expect(auto.autoPositions()).toHaveLength(1);
    expect(sent.some((t) => t.includes("Auto-opened") && t.includes("screen (fake)"))).toBe(true);
    // the screener was shown real on-chain facts for the token it let through
    expect(screen.seen).toHaveLength(1);
    expect(screen.seen[0]!.address).toBe(auto.autoPositions()[0]!.token);
    expect(screen.seen[0]!.symbol).toBe(auto.autoPositions()[0]!.symbol);
    expect(screen.seen[0]!.supplyInPoolPct).toBeGreaterThan(0);
    await auto.tick(); // max open reached → still one
    expect(auto.autoPositions()).toHaveLength(1);

    const held = auto.autoPositions()[0]!;
    settings.set("autoGraceMin", "0");
    settings.set("autoExitAprPct", "1000000000"); // any yield counts as "faded"
    await auto.tick();
    expect(lp.book.get(held.id)).toBeUndefined();
    expect(sent.some((t) => t.includes("Auto-closed") && t.includes("yield faded"))).toBe(true);
    expect(auto.state.cooldowns[held.token]).toBeGreaterThan(Date.now());
  }, 240_000);

  it("does not open what the screener blocks, or anything without a screener", async () => {
    const screen = fakeScreener({ rugSigns: 0.95 });
    const { lp, settings, scanner, auto } = setup("screen", new CachedScreener(screen.s));
    for (let i = 0; i < 3; i++) {
      await churn();
      await scanner.scan();
    }
    for (const [k, v] of [["autoEnabled", "on"], ["autoMinAprPct", "0"], ["autoMaxMovePct", "100"]]) settings.set(k!, v!);
    await auto.tick();
    expect(lp.book.open()).toHaveLength(0);
    expect(screen.seen.length).toBe(2); // both pools asked, both blocked
    for (const f of screen.seen) expect(auto.state.cooldowns[f.address]).toBeGreaterThan(Date.now());

    // /scan shows the cached verdict; /screen answers from cache with the on-chain facts
    const token = screen.seen[0]!.address;
    expect(auto.cachedScreen(token, settings.value)).toMatchObject({ ok: false, reason: "rug signs 95%" });
    const out: string[] = [];
    const tg = { ownerId: "1", send: async (t: string) => (out.push(t), { message_id: out.length }), edit: async (_: number, t: string) => void out.push(t), answer: async () => {} };
    const h = new Handlers(tg as any, lp, settings, auto);
    await h.handle({ chatId: "1", fromId: "1", text: "/scan" });
    expect(out.at(-1)).toContain("🧪🚫");
    await h.handle({ chatId: "1", fromId: "1", text: `/screen ${token}` });
    expect(out.at(-1)).toContain("rug signs 95%");
    expect(out.at(-1)).toContain("autopilot would skip");
    expect(out.at(-1)).toContain("admin functions");
    expect(screen.seen.length).toBe(2); // cached: no new screener call
    await h.handle({ chatId: "1", fromId: "1", text: "/screen 0x000000000000000000000000000000000000beef" });
    expect(out.at(-1)).toContain("no WETH pool");
    // pasting the token for a manual open shows the same warning above the pool picker
    await h.handle({ chatId: "1", fromId: "1", text: token });
    expect(out.at(-1)).toContain("Pick a pool");
    expect(out.at(-1)).toContain("🧪⚠️");
    expect(out.at(-1)).toContain("autopilot would skip: rug signs 95%");

    // same pools, no screener: screening on → nothing opens and the owner is told once
    const bare = setup("screen-none");
    for (let i = 0; i < 3; i++) {
      await churn();
      await bare.scanner.scan();
    }
    for (const [k, v] of [["autoEnabled", "on"], ["autoMinAprPct", "0"], ["autoMaxMovePct", "100"]]) bare.settings.set(k!, v!);
    await bare.auto.tick();
    await bare.auto.tick();
    expect(bare.lp.book.open()).toHaveLength(0);
    expect(bare.sent.filter((t) => t.includes("TYPESAFE_API_KEY"))).toHaveLength(1);
    bare.settings.set("autoScreen", "off");
    await bare.auto.tick();
    expect(bare.lp.book.open()).toHaveLength(1);
  }, 480_000);

  it("respects the daily budget", async () => {
    const { lp, settings, scanner, auto } = setup("budget");
    for (let i = 0; i < 3; i++) {
      await churn();
      await scanner.scan();
    }
    settings.set("autoEnabled", "on");
    settings.set("autoMinAprPct", "0");
    settings.set("autoMaxMovePct", "100");
    settings.set("autoSizeEth", "0.02");
    settings.set("autoDailyEth", "0.01"); // smaller than one position
    await auto.tick();
    expect(lp.book.open()).toHaveLength(0);
  }, 240_000);
});
