/**
 * Cross-check against lp-bot on a local chain with the real Uniswap v3 contracts:
 * lp-bot opens real positions, the dashboard reads the same wallet from the chain, and both
 * must agree on value and fees. Needs lp-bot's dependencies installed (npm ci in ../lp-bot).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { ethers } from "ethers";
import { startEnv, BOT_KEY, type TestEnv } from "../../../lp-bot/test/integration/env";
import { loadConfig as loadLpConfig, SettingsStore } from "../../../lp-bot/src/config";
import { Chain } from "../../../lp-bot/src/chain/client";
import { PositionBook } from "../../../lp-bot/src/lp/positions";
import { LpService } from "../../../lp-bot/src/lp/service";
import { readV3Positions, v3Rows, type V3Chain } from "../../src/sources/univ3";
import { collect } from "../../src/collect";

let env: TestEnv;
beforeAll(async () => {
  env = await startEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

describe("uniswap v3 reader vs lp-bot", () => {
  it("reads the bot wallet's positions with the same value and fees lp-bot computes", async () => {
    const dataDir = path.join(env.dataDir, "pnl");
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = loadLpConfig({
      MODE: "live", CHAIN: "custom", CHAIN_ID: "31337", RPC_URL: env.rpcUrl, WALLET_KEY: BOT_KEY,
      TG_TOKEN: "123456:test-token-test-token-test-token-xx", TG_OWNER_ID: "1", DATA_DIR: dataDir,
      V3_FACTORY: env.contracts.factory, V3_POSITION_MANAGER: env.contracts.positionManager,
      V3_SWAP_ROUTER02: env.contracts.swapRouter02, V3_QUOTER_V2: env.contracts.quoterV2, WETH: env.contracts.weth,
    });
    const chain = new Chain(cfg);
    chain.provider.pollingInterval = 50;
    const settings = new SettingsStore(dataDir);
    const lp = new LpService(chain, new PositionBook(dataDir), () => settings.value, false);

    // one in-range position per pool orientation, then trade through them to earn fees
    const recs = [];
    for (const m of env.markets) {
      const { rec } = await lp.open(await lp.plan(m.pool, ethers.parseEther("1"), "inrange"));
      recs.push(rec);
    }
    for (const m of env.markets) {
      await m.trade(3);
      await m.trade(-3);
    }

    const local: V3Chain = { name: "Local", chainId: 31337, rpcUrl: env.rpcUrl, factory: env.contracts.factory, positionManager: env.contracts.positionManager, weth: env.contracts.weth };
    const found = await readV3Positions(local, chain.address, env.provider);
    expect(found.map((p) => p.tokenId).sort()).toEqual(recs.map((r) => r.id).sort());
    const rows = v3Rows(local, chain.address, found);

    const bot = new Map<string, { value: number; fees: number }>();
    for (const rec of recs) {
      const st = await lp.status(rec);
      const row = rows.find((r) => r.id === rec.id)!;
      bot.set(rec.id, { value: Number(st.pnl.valueQuote) / 1e18, fees: Number(st.pnl.feesQuote) / 1e18 });
      expect(bot.get(rec.id)!.fees).toBeGreaterThan(0);
      expect(row.inRange).toBe(true);
      // the chain sees the position itself: same fees; value excludes the token lp-bot left in the wallet
      expect(row.feesNative!).toBeCloseTo(bot.get(rec.id)!.fees, 9);
      expect(row.valueNative!).toBeLessThanOrEqual(bot.get(rec.id)!.value + 1e-9);
    }

    // end to end: the bot's book + the wallet read merge into one row per position with PnL
    const s = await collect({
      host: "127.0.0.1", port: 0, password: "", refreshSec: 60, solanaRpc: "unused",
      chains: { local }, lpBot: { dataDir, chain: "local" }, wallets: [{ chain: "local" as "base", address: chain.address }],
    }, { v3: (_c, o) => readV3Positions(local, o, env.provider), dlmm: async () => [] });
    expect(s.warnings).toEqual([]);
    const merged = s.rows.filter((r) => r.status === "open");
    expect(merged).toHaveLength(2);
    for (const r of merged) {
      expect(r.source).toBe("lp-bot");
      expect(r.depositNative).toBeCloseTo(1, 9);
      // merged = position + leftover token + collected fees: exactly what lp-bot reports
      expect(r.valueNative!).toBeCloseTo(bot.get(r.id)!.value, 9);
      expect(r.pnlNative).toBeCloseTo(r.valueNative! - 1, 12);
    }
  }, 240_000);
});
