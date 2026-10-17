/**
 * Uniswap v4 against the real contracts: a local fork of Robinhood Chain (PoolManager,
 * PositionManager, StateView, V4Quoter, UniversalRouter, Permit2) and a real native-ETH pool.
 * The bot opens, earns fees from someone else's swaps, collects, closes and sells back, in live
 * mode (real transactions on the fork) and in paper mode. Needs ALCHEMY_KEY (or FORK_URL_ROBINHOOD);
 * skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { loadConfig, SettingsStore } from "../../src/config";
import { Chain } from "../../src/chain/client";
import { PositionBook } from "../../src/lp/positions";
import { LpService } from "../../src/lp/service";
import { readPoolView } from "../../src/chain/pools";
import { encodeV4Swap, quoteV4, V4_POSM_ABI } from "../../src/chain/v4";
import { CHAINS } from "../../src/chains";
import { Scanner } from "../../src/auto/scanner";
import { Autopilot } from "../../src/auto/autopilot";
import { BOT_KEY, TRADER_KEY } from "./env";

const ALCHEMY = process.env.ALCHEMY_KEY?.trim();
const FORK_URL = process.env.FORK_URL_ROBINHOOD || (ALCHEMY ? `https://robinhood-mainnet.g.alchemy.com/v2/${ALCHEMY}` : "");
/** a busy native-ETH / token pool, 0.05% fee, tick spacing 1, no hooks */
const TOKEN = "0x0C07078b2eB6125A5C44DEee88f6CDF5445F187b";
const POOL_ID = "0x1619892c8b7f0b12445a065a57679c6406b1fecb2d315e63406e6839e87909d9";
/** a live hookless pool the V4Quoter can't price either way (NotEnoughLiquidity): must not be offered */
const UNQUOTABLE_TOKEN = "0x6F61575D37B569cD4fc86aBa38F08BAb037b7777";
/** a pool with a hook contract: must be refused */
const HOOKED_POOL_ID = "0xaba846d0f7c612483ca8d3311d0921a823e987fe34426dc4337032b501e3225e";
const v4 = CHAINS.robinhood!.v4!;
// pinned: reproducible, and Hardhat caches a pinned fork's reads on disk (unpinned runs refetch
// every storage slot and trip the RPC's rate limit)
const FORK_BLOCK = process.env.FORK_BLOCK_ROBINHOOD || "90849900";
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];

const require = createRequire(import.meta.url);
let hh: ChildProcess;
let provider: ethers.JsonRpcProvider;
let lp: LpService;
let paper: LpService;
let bot: string;
let url: string;

async function rpcUp(url: string) {
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("fork did not start");
}

/** someone else trades through the pool: ETH → token, so the position earns fees in ETH */
async function traderBuys(eth: string, poolId = POOL_ID) {
  const trader = new ethers.Wallet(TRADER_KEY, provider);
  const key = (await readPoolView(lp.chain, poolId)).v4Key!;
  const data = encodeV4Swap(key, true, ethers.parseEther(eth), 0n, Math.floor(Date.now() / 1000) + 3600);
  await (await trader.sendTransaction({ to: v4.universalRouter, data, value: ethers.parseEther(eth) })).wait();
}

describe.skipIf(!FORK_URL)("Uniswap v4 on a Robinhood Chain fork", () => {
  beforeAll(async () => {
    const port = 10_546 + Math.floor(Math.random() * 1000);
    hh = spawn(process.execPath, [require.resolve("hardhat/internal/cli/cli.js"), "node", "--port", String(port), "--fork", FORK_URL, "--fork-block-number", FORK_BLOCK], {
      cwd: path.join(path.dirname(new URL(import.meta.url).pathname), "hh"),
      stdio: "ignore",
      env: { ...process.env, HH_CHAIN_ID: "4663", HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
    });
    url = `http://127.0.0.1:${port}`;
    await rpcUp(url);
    provider = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true, cacheTimeout: -1 });
    await provider.send("evm_mine", []); // calls at the fork block itself need a hardfork history; one local block avoids it
    bot = new ethers.Wallet(BOT_KEY).address;
    await provider.send("hardhat_setBalance", [bot, ethers.toQuantity(ethers.parseEther("10"))]);
    await provider.send("hardhat_setBalance", [new ethers.Wallet(TRADER_KEY).address, ethers.toQuantity(ethers.parseEther("1000"))]);

    const mk = (mode: "live" | "paper") => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v4-${mode}-`));
      const cfg = loadConfig({ MODE: mode, CHAIN: "robinhood", RPC_URL: url, WALLET_KEY: BOT_KEY, TG_TOKEN: "1:" + "x".repeat(35), TG_OWNER_ID: "1", DATA_DIR: dataDir });
      const settings = new SettingsStore(dataDir);
      return new LpService(new Chain(cfg), new PositionBook(dataDir), () => settings.value, mode === "paper");
    };
    lp = mk("live");
    paper = mk("paper");
  }, 180_000);

  afterAll(() => {
    hh?.kill();
  });

  it("finds the v4 pool for a pasted token, and resolves a pasted pool id", async () => {
    const pools = await lp.findPools(TOKEN);
    const p = pools.find((x) => x.version === 4)!;
    expect(p).toBeDefined();
    expect(p.address).toBe(POOL_ID);
    expect(p.v4Key).toMatchObject({ currency0: ethers.ZeroAddress, fee: 500, tickSpacing: 1, hooks: ethers.ZeroAddress });
    expect(p.quoteIsToken0).toBe(true);
    expect(p.liquidity).toBeGreaterThan(0n);
    const byId = await readPoolView(lp.chain, POOL_ID);
    expect(byId.tick).toBe(p.tick);
    await expect(readPoolView(lp.chain, HOOKED_POOL_ID)).rejects.toThrow(/hook/);
    expect((await lp.findPools(UNQUOTABLE_TOKEN)).filter((x) => x.version === 4)).toEqual([]);
  }, 120_000);

  it("quotes like the router fills", async () => {
    const pool = await readPoolView(lp.chain, POOL_ID);
    const q = await quoteV4(lp.chain, pool.v4Key!, true, ethers.parseEther("0.05"));
    expect(q).toBeGreaterThan(0n);
    expect((await lp.quoteFor(pool, true, ethers.parseEther("0.05"))).out).toBe(q);
  }, 60_000);

  let id: string;
  it("live in-range open: swap via the UniversalRouter, mint via the PositionManager", async () => {
    const before = await provider.getBalance(bot);
    const plan = await lp.plan(POOL_ID, ethers.parseEther("0.2"), "inrange");
    expect(plan.swapInWei).toBeGreaterThan(0n);
    const { rec, txs } = await lp.open(plan);
    id = rec.id;
    expect(rec).toMatchObject({ kind: "live", version: 4, pool: POOL_ID });
    expect(txs.map((t) => t.label)).toEqual(expect.arrayContaining(["swap", "mint"]));
    const posm = new ethers.Contract(v4.positionManager, V4_POSM_ABI, provider);
    expect(await posm.getFunction("ownerOf")(id)).toBe(bot);
    const st = await lp.status(rec);
    expect(st.liquidity).toBe(BigInt(rec.liquidity));
    expect(st.inRange).toBe(true);
    // value after paying the 0.05% swap fee and impact on the token half: within 1% of what went in
    expect(Number(st.pnl.valueQuote)).toBeGreaterThan(Number(ethers.parseEther("0.2")) * 0.99);
    // deposit bookkeeping = what left the wallet (minus gas), and the mint swept unused ETH back
    const spent = before - (await provider.getBalance(bot));
    expect(spent).toBeGreaterThanOrEqual(BigInt(rec.depositQuote));
    expect(spent - BigInt(rec.depositQuote)).toBeLessThan(ethers.parseEther("0.01")); // gas only
    // Permit2 path: exact approvals, nothing unlimited left
    const tok = new ethers.Contract(TOKEN, ERC20, provider);
    expect((await tok.getFunction("allowance")(bot, v4.permit2)) as bigint).toBeLessThan(ethers.parseEther("1000000000"));
  }, 240_000);

  it("earns fees from other people's swaps, collects them", async () => {
    await traderBuys("2");
    const rec = lp.book.get(id)!;
    const st = await lp.status(rec);
    expect(st.feeQuote).toBeGreaterThan(0n);
    const before = await provider.getBalance(bot);
    const { feesQuote, txs } = await lp.collect(id);
    expect(feesQuote).toBeGreaterThan(0n);
    const rc = await provider.getTransactionReceipt(txs[0]!.hash);
    const got = (await provider.getBalance(bot)) - before + rc!.gasUsed * rc!.gasPrice;
    expect(got).toBe(st.feeQuote); // the ETH fees we computed from StateView are exactly what arrived
    expect((await lp.status(lp.book.get(id)!)).feeQuote).toBe(0n);
  }, 240_000);

  it("closes: burns the NFT, sells the token back into the v4 pool, books the PnL", async () => {
    const { closed, txs } = await lp.close(id, "test");
    expect(txs.map((t) => t.label)).toEqual(expect.arrayContaining(["close", "swap"]));
    const posm = new ethers.Contract(v4.positionManager, V4_POSM_ABI, provider);
    await expect(posm.getFunction("ownerOf")(id)).rejects.toThrow();
    expect((await new ethers.Contract(TOKEN, ERC20, provider).getFunction("balanceOf")(bot)) as bigint).toBe(0n);
    expect(BigInt(closed.realizedQuote)).toBeGreaterThan(ethers.parseEther("0.19"));
    expect(lp.book.get(id)).toBeUndefined();
  }, 240_000);

  it("single-sided: all ETH, no swap; closes back to ETH", async () => {
    const plan = await lp.plan(POOL_ID, ethers.parseEther("0.1"), "single");
    const { rec, txs } = await lp.open(plan);
    expect(txs.map((t) => t.label)).toEqual(["mint"]);
    expect(BigInt(rec.depositToken)).toBe(0n);
    const st = await lp.status(rec);
    expect(st.amountToken).toBe(0n);
    const { closed } = await lp.close(rec.id, "test");
    expect(BigInt(closed.realizedQuote)).toBeGreaterThan(ethers.parseEther("0.0999"));
  }, 240_000);

  it("paper mode on the same pool: same reads and quotes, nothing sent", async () => {
    const nonce = await provider.getTransactionCount(bot);
    const plan = await paper.plan(POOL_ID, ethers.parseEther("0.2"), "inrange");
    const { rec, txs } = await paper.open(plan);
    expect(txs).toEqual([]);
    expect(rec).toMatchObject({ kind: "paper", version: 4 });
    const st = await paper.status(rec);
    expect(st.inRange).toBe(true);
    await traderBuys("0.05"); // small: this pool has ~8.5 ETH of active depth, a big buy leaves the range
    const after = await paper.status(paper.book.get(rec.id)!);
    expect(after.inRange).toBe(true);
    expect(after.feeQuote).toBeGreaterThan(0n);
    await paper.close(rec.id, "test");
    expect(await provider.getTransactionCount(bot)).toBe(nonce);
  }, 240_000);

  it("autopilot scanner: indexes hookless native-ETH v4 pools from Swap logs and measures their fee yield", async () => {
    // pool discovery reads logs from the public RPC (the fork would relay them to Alchemy's 10-block cap);
    // all state is read from the fork
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "v4-scan-"));
    const cfg = loadConfig({ MODE: "paper", CHAIN: "robinhood", RPC_URL: url, LOGS_RPC_URL: "https://rpc.mainnet.chain.robinhood.com", TG_TOKEN: "1:" + "x".repeat(35), TG_OWNER_ID: "1", DATA_DIR: dataDir });
    const settings = new SettingsStore(dataDir);
    settings.set("autoMinDepthEth", "0.2");
    // a cold fork fetches every storage slot of a batched call from upstream, one by one
    process.env.RPC_TIMEOUT_MS = "300000";
    const chain = new Chain(cfg);
    delete process.env.RPC_TIMEOUT_MS;
    const scanLp = new LpService(chain, new PositionBook(dataDir), () => settings.value, true);
    const scanner = new Scanner(chain, () => settings.value, dataDir);
    process.env.SCAN_LOOKBACK_BLOCKS = "2000";
    await scanner.scan();
    const first = scanner.ranked();
    const v4s = first.filter((c) => c.version === 4);
    expect(v4s.length).toBeGreaterThan(0);
    for (const c of v4s) expect((await readPoolView(chain, c.pool)).v4Key!.hooks).toBe(ethers.ZeroAddress);
    for (const c of v4s) expect(c.depthWei).toBeGreaterThanOrEqual(ethers.parseEther("0.2")); // autoMinDepthEth

    // the autopilot's round-trip check runs through the v4 pool itself; take the first that passes
    const auto = new Autopilot(scanLp, scanner, () => settings.value, async () => undefined, dataDir);
    let target;
    for (const c of [...v4s].sort((a, b) => (b.depthWei > a.depthWei ? 1 : -1))) {
      if ((await auto.roundTrip(c, ethers.parseEther("0.01"))).ok) {
        target = c;
        break;
      }
    }
    expect(target).toBeDefined();

    // someone trades through it (small against its depth, so the price stays in range), time
    // passes, and the next scan prices what an in-range position earned
    const size = target!.depthWei / 100n < ethers.parseEther("0.05") ? target!.depthWei / 100n : ethers.parseEther("0.05");
    await traderBuys(ethers.formatEther(size), target!.pool);
    await new Promise((r) => setTimeout(r, 31_000)); // the scanner needs ≥30 s between readings
    await scanner.scan();
    const again = scanner.get(target!.pool)!;
    expect(again.version).toBe(4);
    expect(again.samples).toBe(1);
    expect(again.aprPct).toBeGreaterThan(0);
    delete process.env.SCAN_LOOKBACK_BLOCKS;
  }, 600_000);
});

