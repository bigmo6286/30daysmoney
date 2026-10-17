/**
 * Against the real thing: a local fork of Ethereum mainnet with the real Morpho Blue, Uniswap v3
 * pools, SwapRouter02 and QuoterV2 (the integration suite uses a Morpho stand-in and fresh pools).
 * A whale-sized WETH → USDC swap on the 0.3% pool opens a gap against the 0.05% pool; the executor
 * must borrow from the real Morpho, close it, pay the owner exactly the simulated profit and leave
 * Morpho whole. Needs ALCHEMY_KEY (or FORK_URL) and ../lp-bot deps; skipped otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { ethers } from "ethers";
import { CHAINS, loadArtifact, routeFrom, scan, simulate, flashLiquidity, poolsFor, type ChainCfg } from "../../src/arb";
import { main } from "../../src/cli";

const FORK_URL = process.env.FORK_URL || (process.env.ALCHEMY_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY.trim()}` : "");
// pinned so runs are reproducible and Hardhat can cache the forked state
const FORK_BLOCK = process.env.FORK_BLOCK || "26211400";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const OWNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const WHALE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function deposit() payable"];
const ROUTER = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];

const require = createRequire(import.meta.url);
let hh: ChildProcess;
let provider: ethers.JsonRpcProvider;
let rpcUrl: string;
let chain: ChainCfg;
let owner: ethers.NonceManager;
let whale: ethers.NonceManager;
let executor: ethers.Contract;

async function waitForRpc(url: string, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("hardhat fork did not start");
}

/** The whale dumps `eth` WETH for USDC on the 0.3% pool: WETH gets cheap there, USDC dear. */
async function dump(eth: string) {
  const w = await whale.getAddress();
  const weth = new ethers.Contract(chain.weth, ERC20, whale);
  await (await weth.getFunction("deposit")({ value: ethers.parseEther(eth) })).wait();
  await (await weth.getFunction("approve")(chain.swapRouter02, ethers.parseEther(eth))).wait();
  const r = new ethers.Contract(chain.swapRouter02, ROUTER, whale);
  await (await r.getFunction("exactInputSingle")({ tokenIn: chain.weth, tokenOut: USDC, fee: 3000, recipient: w, amountIn: ethers.parseEther(eth), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
}

describe.skipIf(!FORK_URL)("Ethereum mainnet fork: real Morpho Blue + Uniswap v3", () => {
  beforeAll(async () => {
    const port = 9546 + Math.floor(Math.random() * 1000);
    // lp-bot's Hardhat project (Hardhat refuses to run from outside its own install)
    const lpHh = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../lp-bot/test/integration/hh");
    hh = spawn(process.execPath, [require.resolve("../../../lp-bot/node_modules/hardhat/internal/cli/cli.js"), "node", "--port", String(port), "--fork", FORK_URL, "--fork-block-number", FORK_BLOCK], {
      cwd: lpHh,
      stdio: "ignore",
      env: { ...process.env, HH_CHAIN_ID: "1", HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
    });
    rpcUrl = `http://127.0.0.1:${port}`;
    await waitForRpc(rpcUrl);
    provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, cacheTimeout: -1 });
    provider.pollingInterval = 50;
    chain = { ...CHAINS.ethereum!, rpcUrl };
    owner = new ethers.NonceManager(new ethers.Wallet(OWNER_KEY, provider));
    whale = new ethers.NonceManager(new ethers.Wallet(WHALE_KEY, provider));
    await provider.send("hardhat_setBalance", [await whale.getAddress(), ethers.toQuantity(ethers.parseEther("100000"))]);
    await provider.send("hardhat_setBalance", [await owner.getAddress(), ethers.toQuantity(ethers.parseEther("10"))]);

    const art = loadArtifact();
    const ex = await new ethers.ContractFactory(art.abi as ethers.InterfaceAbi, art.bytecode, owner).deploy(chain.morpho, [chain.swapRouter02]);
    await ex.waitForDeployment();
    executor = new ethers.Contract(await ex.getAddress(), art.abi as ethers.InterfaceAbi, owner);
  }, 300_000);

  afterAll(() => {
    hh?.kill();
  });

  it("sees the real Morpho liquidity and the real WETH/USDC pools", async () => {
    expect(await flashLiquidity(provider, chain, chain.weth)).toBeGreaterThan(ethers.parseEther("1000"));
    expect(await poolsFor(provider, chain, chain.weth, USDC)).toEqual([100, 500, 3000, 10000]);
  });

  it("an efficient market: nothing to take before the dump", async () => {
    const found = await scan(provider, chain, chain.weth, USDC, ethers.parseEther("1"), ethers.parseEther("64"));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.gross).toBeLessThanOrEqual(0n); // fees on both legs exceed any gap between tiers
  }, 300_000);

  it("after a whale dump: flash-borrows from Morpho, closes the gap, pays exactly the simulated profit", async () => {
    await dump("3000");
    const found = await scan(provider, chain, chain.weth, USDC, ethers.parseEther("1"), ethers.parseEther("512"));
    const best = found[0]!;
    expect(best.sell.fee).toBe(3000); // sell USDC back where WETH is now cheap
    expect(best.gross).toBeGreaterThan(0n);

    const now = (await provider.getBlock("latest"))!.timestamp;
    const ownerAddr = await owner.getAddress();
    const route = routeFrom(best, best.gross / 2n, 50, now);
    const sim = await simulate(executor, ownerAddr, route);
    expect(sim).toMatchObject({ ok: true });
    expect(sim.profit).toBe(best.gross);

    const weth = new ethers.Contract(chain.weth, ERC20, provider);
    const usdc = new ethers.Contract(USDC, ERC20, provider);
    const morphoBefore = (await weth.getFunction("balanceOf")(chain.morpho)) as bigint;
    const before = (await weth.getFunction("balanceOf")(ownerAddr)) as bigint;
    const rc = await (await executor.getFunction("execute")(route)).wait();
    expect(rc!.status).toBe(1);
    expect(((await weth.getFunction("balanceOf")(ownerAddr)) as bigint) - before).toBe(best.gross);

    const exAddr = await executor.getAddress();
    expect(await weth.getFunction("balanceOf")(chain.morpho)).toBe(morphoBefore); // repaid in the same tx, no fee
    expect(await weth.getFunction("balanceOf")(exAddr)).toBe(0n);
    expect(await usdc.getFunction("balanceOf")(exAddr)).toBe(0n);
    expect(await weth.getFunction("allowance")(exAddr, chain.swapRouter02)).toBe(0n);
    expect(await weth.getFunction("allowance")(exAddr, chain.morpho)).toBe(0n);
    expect(await usdc.getFunction("allowance")(exAddr, chain.swapRouter02)).toBe(0n);

    // the gap is gone: the same floor now reverts with NoProfit instead of losing money
    const again = await simulate(executor, ownerAddr, routeFrom(best, best.gross / 2n, 50, now));
    expect(again.ok).toBe(false);
  }, 300_000); // every new storage slot is a round trip to the fork RPC

  it("the CLI with the stock `--chain ethereum` preset: dry run, then --exec --yes", async () => {
    await dump("2000");
    Object.assign(process.env, { PRIVATE_KEY: OWNER_KEY, RPC_URL_ETHEREUM: rpcUrl });
    const args = ["arb", "--chain", "ethereum", "--executor", await executor.getAddress(), "--mid", USDC, "--min", "1", "--max", "512"];
    const dry: string[] = [];
    await main(args, (l) => dry.push(l));
    expect(dry.join("\n")).toMatch(/→ sell 0.3%/);
    expect(dry.join("\n")).toContain("dry run: add --exec --yes");

    const weth = new ethers.Contract(chain.weth, ERC20, provider);
    const ownerAddr = await owner.getAddress();
    const before = (await weth.getFunction("balanceOf")(ownerAddr)) as bigint;
    const out: string[] = [];
    await main([...args, "--exec", "--yes"], (l) => out.push(l));
    expect(out.join("\n")).toMatch(/status ok/);
    expect((await weth.getFunction("balanceOf")(ownerAddr)) as bigint).toBeGreaterThan(before);
  }, 300_000);
});
