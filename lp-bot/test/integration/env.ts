/**
 * Spins up a local Hardhat chain with the real Uniswap v3 contracts (factory, NPM, SwapRouter02,
 * QuoterV2), a WETH9, and a TEST token / WETH pool seeded with liquidity.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ethers } from "ethers";
import { encodeSqrtRatioX96, nearestUsableTick, TickMath } from "@uniswap/v3-sdk";
import { compileTestContracts } from "./contracts";

const require = createRequire(import.meta.url);
const art = (p: string) => require(p) as { abi: any[]; bytecode: string };

// Hardhat's well-known dev keys
export const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const BOT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TRADER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

export interface Market {
  symbol: string;
  token: string;
  pool: string;
  wethIsToken0: boolean;
  /** move the price by trading `ethIn` ETH (positive = buy token, negative = sell token worth ~|ethIn|) */
  trade(ethIn: number): Promise<void>;
}

export interface TestEnv {
  rpcUrl: string;
  provider: ethers.JsonRpcProvider;
  contracts: { factory: string; positionManager: string; swapRouter02: string; quoterV2: string; weth: string };
  /** [0]: WETH is token0 · [1]: WETH is token1, so both pool orientations are exercised */
  markets: Market[];
  fee: number;
  dataDir: string;
  stop(): Promise<void>;
}

async function waitForRpc(url: string, ms = 60_000) {
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
  throw new Error("hardhat node did not start");
}

export async function startEnv(port = 8546 + Math.floor(Math.random() * 1000)): Promise<TestEnv> {
  const cwd = path.join(path.dirname(new URL(import.meta.url).pathname), "hh");
  const hh: ChildProcess = spawn(process.execPath, [require.resolve("hardhat/internal/cli/cli.js"), "node", "--port", String(port)], {
    cwd,
    stdio: "ignore",
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForRpc(rpcUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 50;
  const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, provider));
  const trader = new ethers.NonceManager(new ethers.Wallet(TRADER_KEY, provider));

  const deploy = async (a: { abi: any[]; bytecode: string }, ...args: unknown[]) => {
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const local = compileTestContracts();
  const weth = await deploy(local.WETH9);
  const factory = await deploy(art("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"));
  const npm = await deploy(
    art("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
    await factory.getAddress(),
    await weth.getAddress(),
    ethers.ZeroAddress, // token descriptor only matters for tokenURI()
  );
  const router = await deploy(
    art("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json"),
    ethers.ZeroAddress,
    await factory.getAddress(),
    await npm.getAddress(),
    await weth.getAddress(),
  );
  const quoter = await deploy(
    art("@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json"),
    await factory.getAddress(),
    await weth.getAddress(),
  );

  const wethAddr = await weth.getAddress();
  const fee = 3000;
  await (await (weth as any).deposit({ value: ethers.parseEther("400") })).wait();
  await (await (weth as any).approve(await npm.getAddress(), ethers.MaxUint256)).wait();

  /** TEST/WETH pool at 1 TEST = 0.0001 ETH, seeded with 100 ETH + 1M TEST full range. */
  async function makeMarket(symbol: string, wantTokenFirst: boolean): Promise<Market> {
    // deploy until the token sorts on the requested side of WETH (addresses are deterministic)
    let token: ethers.BaseContract;
    for (let i = 0; ; i++) {
      token = await deploy(local.TestToken, symbol, symbol, 18, ethers.parseEther("1000000000"));
      const below = (await token.getAddress()).toLowerCase() < wethAddr.toLowerCase();
      if (below === wantTokenFirst) break;
      if (i > 40) throw new Error("could not get the wanted token ordering");
    }
    const tokenAddr = await token.getAddress();
    const [t0, t1] = wethAddr.toLowerCase() < tokenAddr.toLowerCase() ? [wethAddr, tokenAddr] : [tokenAddr, wethAddr];
    const sqrt = t0 === wethAddr ? encodeSqrtRatioX96("10000", "1") : encodeSqrtRatioX96("1", "10000");
    await (await (npm as any).createAndInitializePoolIfNecessary(t0, t1, fee, sqrt.toString())).wait();
    const pool = await (factory as any).getPool(t0, t1, fee);
    await (await (token as any).approve(await npm.getAddress(), ethers.MaxUint256)).wait();
    const amt = (a: string) => (a === wethAddr ? ethers.parseEther("100") : ethers.parseEther("1000000"));
    await (
      await (npm as any).mint({
        token0: t0,
        token1: t1,
        fee,
        tickLower: nearestUsableTick(TickMath.MIN_TICK, 60),
        tickUpper: nearestUsableTick(TickMath.MAX_TICK, 60),
        amount0Desired: amt(t0),
        amount1Desired: amt(t1),
        amount0Min: 0,
        amount1Min: 0,
        recipient: await deployer.getAddress(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
      })
    ).wait();
    // trader gets the token to sell
    await (await (token as any).transfer(await trader.getAddress(), ethers.parseEther("10000000"))).wait();
    const tokenT = new ethers.Contract(tokenAddr, local.TestToken.abi, trader);
    await (await tokenT.getFunction("approve")(await router.getAddress(), ethers.MaxUint256)).wait();
    const routerT = new ethers.Contract(await router.getAddress(), router.interface, trader);
    return {
      symbol,
      token: tokenAddr,
      pool,
      wethIsToken0: t0 === wethAddr,
      async trade(ethIn: number) {
        const me = await trader.getAddress();
        if (ethIn > 0) {
          const v = ethers.parseEther(String(ethIn));
          await (await routerT.getFunction("exactInputSingle")({ tokenIn: wethAddr, tokenOut: tokenAddr, fee, recipient: me, amountIn: v, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }, { value: v })).wait();
        } else {
          const v = ethers.parseEther(String(-ethIn * 10_000)); // ~price-equivalent amount of token
          await (await routerT.getFunction("exactInputSingle")({ tokenIn: tokenAddr, tokenOut: wethAddr, fee, recipient: me, amountIn: v, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
        }
      },
    };
  }

  const markets = [await makeMarket("TEST", false), await makeMarket("TSET", true)];

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lpbot-"));
  return {
    rpcUrl,
    provider,
    contracts: {
      factory: await factory.getAddress(),
      positionManager: await npm.getAddress(),
      swapRouter02: await router.getAddress(),
      quoterV2: await quoter.getAddress(),
      weth: wethAddr,
    },
    markets,
    fee,
    dataDir,
    async stop() {
      provider.destroy();
      hh.kill("SIGTERM");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
