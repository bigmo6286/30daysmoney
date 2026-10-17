import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { startEnv, BOT_KEY, type TestEnv } from "./env";
import { loadConfig, SettingsStore } from "../../src/config";
import { Chain } from "../../src/chain/client";
import { PositionBook } from "../../src/lp/positions";
import { LpService } from "../../src/lp/service";
import { Handlers } from "../../src/bot/handlers";
import { Monitor } from "../../src/monitor";
import { ERC20_ABI, NPM_ABI } from "../../src/chain/abis";

let env: TestEnv;

function service(mode: "live" | "paper", sub: string) {
  const dataDir = path.join(env.dataDir, sub);
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg = loadConfig({
    MODE: mode,
    CHAIN: "custom",
    CHAIN_ID: "31337",
    RPC_URL: env.rpcUrl,
    WALLET_KEY: BOT_KEY,
    TG_TOKEN: "test",
    TG_OWNER_ID: "1",
    DATA_DIR: dataDir,
    V3_FACTORY: env.contracts.factory,
    V3_POSITION_MANAGER: env.contracts.positionManager,
    V3_SWAP_ROUTER02: env.contracts.swapRouter02,
    V3_QUOTER_V2: env.contracts.quoterV2,
    WETH: env.contracts.weth,
  });
  const chain = new Chain(cfg);
  chain.provider.pollingInterval = 50;
  const settings = new SettingsStore(dataDir);
  const lp = new LpService(chain, new PositionBook(dataDir), () => settings.value, mode === "paper");
  return { lp, settings, chain };
}

/** Records what the bot would have sent to Telegram. */
class FakeTg {
  sent: { text: string; kb?: any }[] = [];
  ownerId = "1";
  async send(text: string, kb?: any) {
    this.sent.push({ text, kb });
    return { message_id: this.sent.length };
  }
  async edit(_id: number, text: string, kb?: any) {
    this.sent.push({ text, kb });
  }
  async answer() {}
  last() {
    return this.sent[this.sent.length - 1]!;
  }
}

beforeAll(async () => {
  env = await startEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

describe.each([0, 1])("live mode, market %i", (mi) => {
  const m = () => env.markets[mi]!;
  it("finds the pool", async () => {
    const { lp } = service("live", `find${mi}`);
    const pools = await lp.findPools(m().token);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.address).toBe(m().pool);
    expect(pools[0]!.token.symbol).toBe(m().symbol);
    expect(pools[0]!.quoteIsToken0).toBe(m().wethIsToken0);
    expect(Number(pools[0]!.priceE18) / 1e18).toBeCloseTo(0.0001, 6);
  });

  it("opens single-side, earns nothing until price dips, closes for ~deposit", async () => {
    const { lp, chain } = service("live", `single${mi}`);
    const before = await chain.nativeBalance();
    const plan = await lp.plan(m().pool, ethers.parseEther("1"), "single");
    expect(plan.priceUpper).toBeLessThan(0.0001);
    const { rec, txs } = await lp.open(plan);
    expect(txs.map((t) => t.label)).toEqual(["mint"]); // single-side ETH is one transaction
    const npm = new ethers.Contract(env.contracts.positionManager, NPM_ABI, env.provider);
    expect(await npm.getFunction("ownerOf")(rec.id)).toBe(chain.address);

    const st = await lp.status(rec);
    expect(st.inRange).toBe(false);
    expect(st.amountToken).toBe(0n);
    expect(st.pnl.valueQuote).toBeGreaterThan(ethers.parseEther("0.9999"));

    const { closed } = await lp.close(rec.id);
    expect(BigInt(closed.realizedQuote)).toBeGreaterThan(ethers.parseEther("0.9999"));
    await expect(npm.getFunction("ownerOf")(rec.id)).rejects.toThrow(); // NFT burned
    const after = await chain.nativeBalance();
    expect(before - after).toBeLessThan(ethers.parseEther("0.01")); // only gas spent
  });

  it("opens in-range, accrues real fees, collects, closes back to ETH", async () => {
    const { lp, chain } = service("live", `inrange${mi}`);
    const plan = await lp.plan(m().pool, ethers.parseEther("2"), "inrange");
    expect(plan.swapInWei).toBeGreaterThan(0n);
    const { rec, txs } = await lp.open(plan);
    expect(txs.map((t) => t.label)).toEqual(["swap", "approve", "mint"]);
    // generate volume through our range
    for (let i = 0; i < 4; i++) {
      await m().trade(5);
      await m().trade(-5);
    }
    const st = await lp.status(rec);
    expect(st.inRange).toBe(true);
    expect(st.pnl.feesQuote).toBeGreaterThan(0n);

    const { feesQuote } = await lp.collect(rec.id);
    expect(feesQuote).toBeGreaterThan(0n);
    expect((await lp.status(rec)).feeQuote).toBe(0n);

    const { closed } = await lp.close(rec.id);
    const token = new ethers.Contract(m().token, ERC20_ABI, env.provider);
    expect(await token.getFunction("balanceOf")(chain.address)).toBeLessThan(ethers.parseEther("1")); // swept back to ETH
    expect(BigInt(closed.feesQuote)).toBeGreaterThan(0n);
    // round trip costs two swaps (0.3% each on part of the deposit); fees offset some of it
    expect(closed.pnlPct).toBeGreaterThan(-2);
  });

  it("refuses to spend the gas reserve", async () => {
    const { lp, chain } = service("live", `reserve${mi}`);
    const bal = await chain.nativeBalance();
    const plan = await lp.plan(m().pool, bal, "single");
    await expect(lp.open(plan)).rejects.toThrow(/insufficient ETH/);
  });

  it("rebalances an out-of-range position around the new price", async () => {
    const { lp } = service("live", `rebalance${mi}`);
    const { rec } = await lp.open(await lp.plan(m().pool, ethers.parseEther("1"), "inrange"));
    await m().trade(40); // pump TEST well above the ±20% range
    expect((await lp.status(rec)).inRange).toBe(false);
    const { rec: next } = await lp.rebalance(rec.id);
    expect(next.id).not.toBe(rec.id);
    expect((await lp.status(next)).inRange).toBe(true);
    await lp.close(next.id);
    await m().trade(-40);
  });
});

describe("paper mode", () => {
  it("never sends a transaction but tracks the position and estimated fees", async () => {
    const { lp, chain } = service("paper", "paper");
    const nonce = await env.provider.getTransactionCount(chain.address);
    const { rec, txs } = await lp.open(await lp.plan(env.markets[0]!.pool, ethers.parseEther("3"), "inrange"));
    expect(txs).toHaveLength(0);
    expect(rec.id).toBe("P1");
    expect(rec.kind).toBe("paper");
    await lp.status(rec); // snapshot
    for (let i = 0; i < 3; i++) {
      await env.markets[0]!.trade(5);
      await env.markets[0]!.trade(-5);
      await lp.status(rec);
    }
    const st = await lp.status(rec);
    expect(st.pnl.feesQuote).toBeGreaterThan(0n);
    const { closed } = await lp.close(rec.id);
    expect(BigInt(closed.realizedQuote)).toBeGreaterThan(0n);
    expect(await env.provider.getTransactionCount(chain.address)).toBe(nonce);
    expect(lp.book.closed()[0]!.id).toBe("P1");
  });
});

describe("telegram flow", () => {
  it("paste token → pool → amount → mode → confirm → list → close", async () => {
    const { lp, settings } = service("paper", "tg");
    const tg = new FakeTg();
    const h = new Handlers(tg as any, lp, settings);
    const say = (text: string) => h.handle({ chatId: "1", fromId: "1", text });
    const tap = (data: string) => h.handle({ chatId: "1", fromId: "1", callback: { id: "x", data, messageId: 1 } });

    await say(env.markets[0]!.token);
    expect(tg.last().text).toContain("TEST");
    expect(tg.last().kb[0][0].data).toBe("p:0");
    await tap("p:0");
    expect(tg.last().text).toContain("How much ETH");
    await say("0.5");
    expect(tg.last().text).toContain("Single-side");
    expect(tg.last().text).toContain("In-range");
    await tap("m:inrange");
    expect(tg.last().text).toContain("Confirm");
    await tap("go");
    expect(tg.last().text).toContain("Opened <b>#P1</b>");
    await say("/list");
    expect(tg.last().text).toContain("TEST");
    expect(tg.last().text).toContain("TOTAL");
    await tap("cc:P1");
    expect(tg.last().text).toContain("Closed #P1");
    await say("/history");
    expect(tg.last().text).toContain("#P1");
    await say("/set widthPct 35");
    expect(settings.value.widthPct).toBe(35);
    await say("/set nonsense 1");
    expect(tg.last().text).toContain("unknown setting");
  });

  it("monitor alerts on range exit and auto-closes on stop-loss", async () => {
    const { lp, settings } = service("paper", "mon");
    const tg = new FakeTg();
    const h = new Handlers(tg as any, lp, settings);
    const mon = new Monitor(lp, tg as any, h);
    settings.set("widthPct", "5");
    const { rec } = await lp.open(await lp.plan(env.markets[0]!.pool, ethers.parseEther("1"), "inrange"));
    await mon.tick();
    expect(lp.book.get(rec.id)!.inRange).toBe(true);
    await env.markets[0]!.trade(-15); // dump TEST below the ±5% range
    await mon.tick();
    expect(tg.sent.some((m) => m.text.includes("Out of range"))).toBe(true);
    settings.set("slPct", "0.5");
    await mon.tick();
    expect(tg.sent.some((m) => m.text.includes("Auto-closed"))).toBe(true);
    expect(lp.book.get(rec.id)).toBeUndefined();
    await env.markets[0]!.trade(15);
  });
});
