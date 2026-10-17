/**
 * End to end on a local chain with the real Uniswap v3 contracts (lp-bot's test environment):
 * a second TEST/WETH pool priced 5% off creates a real arbitrage; a Morpho Blue stand-in lends
 * WETH exactly like Morpho does (send → callback → pull back). Needs ../lp-bot deps installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { startEnv, DEPLOYER_KEY, BOT_KEY, TRADER_KEY, type TestEnv } from "../../../lp-bot/test/integration/env";
import { loadArtifact, quote, routeFrom, scan, simulate, flashLiquidity, poolsFor, type ChainCfg } from "../../src/arb";
import { compileFlashArb } from "../../src/compile";
import { main } from "../../src/cli";

const MOCK_MORPHO = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC20 { function transfer(address, uint256) external returns (bool); function transferFrom(address, address, uint256) external returns (bool); }
interface ICallback { function onMorphoFlashLoan(uint256 assets, bytes calldata data) external; }
/// Same flow as Morpho Blue's flashLoan: send, call back msg.sender, pull the same amount back.
contract MockMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        require(assets != 0, "zero");
        IERC20(token).transfer(msg.sender, assets);
        ICallback(msg.sender).onMorphoFlashLoan(assets, data);
        require(IERC20(token).transferFrom(msg.sender, address(this), assets), "repay");
    }
}`;

function compileMock() {
  const solc = createRequire(import.meta.url)("solc");
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "M.sol": { content: MOCK_MORPHO } }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } })));
  const c = out.contracts["M.sol"].MockMorpho;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

const isqrt = (n: bigint) => {
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
};
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"];
const NPM = [
  "function createAndInitializePoolIfNecessary(address,address,uint24,uint160) returns (address)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) returns (uint256,uint128,uint256,uint256)",
];

let env: TestEnv;
let chain: ChainCfg;
let token: string;
let executor: ethers.Contract;
let owner: ethers.NonceManager;
let morpho: string;

beforeAll(async () => {
  env = await startEnv();
  const deployer = new ethers.NonceManager(new ethers.Wallet(DEPLOYER_KEY, env.provider));
  owner = new ethers.NonceManager(new ethers.Wallet(BOT_KEY, env.provider));
  const m = env.markets[0]!; // WETH is token0: price = TEST per WETH
  token = m.token;
  const weth = env.contracts.weth;
  const [t0, t1] = [weth, token];
  expect(weth.toLowerCase() < token.toLowerCase()).toBe(true);

  // fee-500 pool where TEST is ~5% cheaper (10,500 TEST per WETH vs 10,000)
  const npm = new ethers.Contract(env.contracts.positionManager, NPM, deployer);
  await (await npm.getFunction("createAndInitializePoolIfNecessary")(t0, t1, 500, isqrt(10_500n << 192n))).wait();
  await (
    await npm.getFunction("mint")({
      token0: t0, token1: t1, fee: 500, tickLower: -887270, tickUpper: 887270,
      amount0Desired: ethers.parseEther("20"), amount1Desired: ethers.parseEther("210000"),
      amount0Min: 0, amount1Min: 0, recipient: await deployer.getAddress(), deadline: Math.floor(Date.now() / 1000) + 3600,
    })
  ).wait();

  const mock = compileMock();
  const mm = await new ethers.ContractFactory(mock.abi, mock.bytecode, deployer).deploy();
  await mm.waitForDeployment();
  morpho = await mm.getAddress();
  await (await new ethers.Contract(weth, ERC20, deployer).getFunction("transfer")(morpho, ethers.parseEther("50"))).wait();

  const art = loadArtifact();
  const ex = await new ethers.ContractFactory(art.abi as ethers.InterfaceAbi, art.bytecode, owner).deploy(morpho, [env.contracts.swapRouter02]);
  await ex.waitForDeployment();
  executor = new ethers.Contract(await ex.getAddress(), art.abi as ethers.InterfaceAbi, owner);
  chain = { name: "local", chainId: 31337, rpcUrl: env.rpcUrl, morpho, swapRouter02: env.contracts.swapRouter02, quoterV2: env.contracts.quoterV2, factory: env.contracts.factory, weth };
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe("flash arbitrage", () => {
  it("the committed artifact is exactly what the source compiles to", () => {
    const fresh = compileFlashArb();
    const committed = loadArtifact();
    expect(committed.sourceHash).toBe(fresh.sourceHash);
    expect(committed.bytecode).toBe(fresh.bytecode);
  });

  it("reverts every unsafe or unprofitable call", async () => {
    const ownerAddr = await owner.getAddress();
    const now = (await env.provider.getBlock("latest"))!.timestamp;
    // the most profitable size right now (the cheap pool is shallow, so bigger isn't better)
    const q = (await scan(env.provider, chain, chain.weth, token, ethers.parseEther("0.25"), ethers.parseEther("8")))[0]!;
    expect(q.gross).toBeGreaterThan(0n);
    const ok = routeFrom(q, 0n, 50, now);
    expect((await simulate(executor, ownerAddr, ok)).ok).toBe(true);

    const tooGreedy = await simulate(executor, ownerAddr, { ...ok, minProfit: ethers.parseEther("1") });
    expect(tooGreedy.reason).toMatch(/^NoProfit\(/);

    const reverse = (await quote(env.provider, chain, { loanToken: chain.weth, midToken: token, amount: q.amount, buyFee: 3000, sellFee: 500 }))!;
    expect(reverse.gross).toBeLessThan(0n);
    expect((await simulate(executor, ownerAddr, routeFrom(reverse, 0n, 50, now))).ok).toBe(false); // sell leg can't repay

    expect((await simulate(executor, ownerAddr, { ...ok, deadline: BigInt(now - 1) })).reason).toBe("Expired()");
    const rogue = ethers.Wallet.createRandom().address;
    expect((await simulate(executor, ownerAddr, { ...ok, sellRouter: rogue })).reason).toBe(`RouterNotAllowed(${rogue})`);

    const stranger = new ethers.Wallet(TRADER_KEY, env.provider).address;
    const ro = executor.connect(env.provider) as ethers.Contract; // read-only: calls `from` anyone
    expect((await simulate(ro, stranger, ok)).reason).toBe("NotOwner()");
    // nobody can call the callback directly to make the executor trade or pay out
    const cb = ro.getFunction("onMorphoFlashLoan");
    await expect(cb.staticCall(1n, "0x", { from: stranger })).rejects.toMatchObject({ revert: { name: "NotMorpho" } });
    // even Morpho's own address can't trigger it outside our own call
    await expect(cb.staticCall(1n, "0x", { from: morpho })).rejects.toMatchObject({ revert: { name: "NoActiveRoute" } });
    // only the owner can change the allowlist
    await expect(executor.connect(new ethers.Wallet(TRADER_KEY, env.provider)).getFunction("setRouter").staticCall(rogue, true)).rejects.toMatchObject({ revert: { name: "NotOwner" } });
  });
  it("finds the opportunity, simulates it, and executes it for the predicted profit", async () => {
    expect(await flashLiquidity(env.provider, chain, chain.weth)).toBe(ethers.parseEther("50"));
    expect(await poolsFor(env.provider, chain, chain.weth, token)).toEqual([500, 3000]);
    const found = await scan(env.provider, chain, chain.weth, token, ethers.parseEther("0.25"), ethers.parseEther("8"));
    const best = found[0]!;
    expect(best.buy.fee).toBe(500); // buy where TEST is cheap
    expect(best.sell.fee).toBe(3000);
    expect(best.gross).toBeGreaterThan(0n);
    expect(found.filter((q) => q.buy.fee === 3000).every((q) => q.gross < 0n)).toBe(true); // reverse never pays

    const now = (await env.provider.getBlock("latest"))!.timestamp;
    const route = routeFrom(best, best.gross / 2n, 50, now);
    const ownerAddr = await owner.getAddress();
    const sim = await simulate(executor, ownerAddr, route);
    expect(sim).toMatchObject({ ok: true });
    expect(sim.profit).toBe(best.gross); // the quoter and the real swaps agree exactly
    expect(sim.gas).toBeGreaterThan(0n);

    const wethC = new ethers.Contract(chain.weth, ERC20, env.provider);
    const before = (await wethC.getFunction("balanceOf")(ownerAddr)) as bigint;
    await (await executor.getFunction("execute")(route)).wait();
    const after = (await wethC.getFunction("balanceOf")(ownerAddr)) as bigint;
    expect(after - before).toBe(best.gross);
    // nothing left behind in the executor, nothing approved, Morpho made whole
    const exAddr = await executor.getAddress();
    expect(await wethC.getFunction("balanceOf")(exAddr)).toBe(0n);
    expect(await new ethers.Contract(token, ERC20, env.provider).getFunction("balanceOf")(exAddr)).toBe(0n);
    expect(await wethC.getFunction("allowance")(exAddr, env.contracts.swapRouter02)).toBe(0n);
    expect(await wethC.getFunction("allowance")(exAddr, morpho)).toBe(0n);
    expect(await wethC.getFunction("balanceOf")(morpho)).toBe(ethers.parseEther("50"));

    // the same route again: the gap has narrowed, so asking for the old profit now reverts
    const again = await simulate(executor, ownerAddr, routeFrom(best, best.gross, 50, now));
    expect(again.ok).toBe(false);
  });


  it("the CLI's arb command: dry run, then --exec --yes for the simulated profit", async () => {
    // reopen the gap: someone buys TEST on the 0.3% pool, making it pricier there
    await env.markets[0]!.trade(6);
    Object.assign(process.env, {
      PRIVATE_KEY: BOT_KEY, RPC_URL_CUSTOM: env.rpcUrl, CUSTOM_CHAIN_ID: "31337", CUSTOM_MORPHO: morpho,
      CUSTOM_ROUTER: env.contracts.swapRouter02, CUSTOM_QUOTER: env.contracts.quoterV2, CUSTOM_FACTORY: env.contracts.factory, CUSTOM_WETH: env.contracts.weth,
    });
    const args = ["arb", "--chain", "custom", "--executor", await executor.getAddress(), "--mid", token, "--min", "0.25", "--max", "8"];
    const dry: string[] = [];
    await main(args, (l) => dry.push(l));
    expect(dry.join("\n")).toMatch(/best: buy 0.05% → sell 0.3%/);
    expect(dry.join("\n")).toContain("dry run: add --exec --yes");

    await expect(main([...args, "--exec"], () => {})).rejects.toThrow(/--yes/);

    const wethC = new ethers.Contract(chain.weth, ERC20, env.provider);
    const ownerAddr = await owner.getAddress();
    const before = (await wethC.getFunction("balanceOf")(ownerAddr)) as bigint;
    const out: string[] = [];
    await main([...args, "--exec", "--yes"], (l) => out.push(l));
    expect(out.join("\n")).toMatch(/status ok/);
    expect((await wethC.getFunction("balanceOf")(ownerAddr)) as bigint).toBeGreaterThan(before);

    // a floor it can't reach: skipped, nothing sent
    const skip: string[] = [];
    await main([...args, "--exec", "--yes", "--min-profit", "5"], (l) => skip.push(l));
    expect(skip.join("\n")).toMatch(/no profitable route|below your floor/);
    expect(skip.join("\n")).not.toMatch(/sent 0x/);
  });
});
