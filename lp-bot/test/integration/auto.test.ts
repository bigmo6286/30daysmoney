import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startEnv, BOT_KEY, type TestEnv } from "./env";
import { loadConfig, SettingsStore } from "../../src/config";
import { Chain } from "../../src/chain/client";
import { PositionBook } from "../../src/lp/positions";
import { LpService } from "../../src/lp/service";
import { Scanner } from "../../src/auto/scanner";
import { Autopilot } from "../../src/auto/autopilot";

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

function setup(sub: string) {
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
  const auto = new Autopilot(lp, scanner, () => settings.value, async (t) => sent.push(t), dataDir);
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
    const { lp, settings, scanner, auto, sent } = setup("auto");
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
    expect(sent.some((t) => t.includes("Auto-opened"))).toBe(true);
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
