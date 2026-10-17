/**
 * Two-pool flash arbitrage on Uniswap v3-style DEXes, funded by a Morpho Blue flash loan:
 * quote both legs with QuoterV2, size it, then simulate the executor's `execute` from the
 * owner (eth_call) before anything is sent. The on-chain executor re-checks everything.
 */
import fs from "node:fs";
import { ethers } from "ethers";
import type { Artifact } from "./compile";

export interface ChainCfg {
  name: string;
  chainId: number;
  rpcUrl: string;
  /** Alchemy network slug, used instead of rpcUrl when ALCHEMY_KEY is set */
  alchemy?: string;
  morpho: string;
  swapRouter02: string;
  quoterV2: string;
  factory: string;
  weth: string;
}

/** Morpho Blue + Uniswap v3 periphery per chain. Robinhood's Morpho address is from FlipZ3ro's toolkit (live-tested there). */
export const CHAINS: Record<string, ChainCfg> = {
  robinhood: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    alchemy: "robinhood-mainnet",
    morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
    swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    alchemy: "base-mainnet",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
  },
  ethereum: {
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    alchemy: "eth-mainnet",
    morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
};

export const FEE_TIERS = [100, 500, 3000, 10000];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];

export interface Leg {
  router: string;
  fee: number;
}

export interface Quote {
  loanToken: string;
  midToken: string;
  amount: bigint;
  buy: Leg;
  sell: Leg;
  midOut: bigint;
  back: bigint;
  /** back − amount (Morpho flash loans are free) */
  gross: bigint;
}

export function loadArtifact(): Artifact {
  return JSON.parse(fs.readFileSync(new URL("../artifacts/FlashArb.json", import.meta.url), "utf8")) as Artifact;
}

/** How much of `token` Morpho holds, i.e. the most one flash loan can borrow. */
export async function flashLiquidity(provider: ethers.Provider, chain: ChainCfg, token: string): Promise<bigint> {
  return (await new ethers.Contract(token, ERC20_ABI, provider).getFunction("balanceOf")(chain.morpho)) as bigint;
}

async function quoteLeg(quoter: ethers.Contract, tokenIn: string, tokenOut: string, fee: number, amountIn: bigint): Promise<bigint | null> {
  try {
    const r = await quoter.getFunction("quoteExactInputSingle").staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 });
    return r[0] as bigint;
  } catch {
    return null; // no pool / no liquidity at this tier
  }
}

export async function quote(provider: ethers.Provider, chain: ChainCfg, q: { loanToken: string; midToken: string; amount: bigint; buyFee: number; sellFee: number }): Promise<Quote | null> {
  const quoter = new ethers.Contract(chain.quoterV2, QUOTER_ABI, provider);
  const midOut = await quoteLeg(quoter, q.loanToken, q.midToken, q.buyFee, q.amount);
  if (!midOut) return null;
  const back = await quoteLeg(quoter, q.midToken, q.loanToken, q.sellFee, midOut);
  if (back === null) return null;
  const leg = (fee: number): Leg => ({ router: chain.swapRouter02, fee });
  return { loanToken: q.loanToken, midToken: q.midToken, amount: q.amount, buy: leg(q.buyFee), sell: leg(q.sellFee), midOut, back, gross: back - q.amount };
}

/** Which fee tiers have a pool for this pair. */
export async function poolsFor(provider: ethers.Provider, chain: ChainCfg, a: string, b: string): Promise<number[]> {
  const f = new ethers.Contract(chain.factory, FACTORY_ABI, provider);
  const out: number[] = [];
  for (const fee of FEE_TIERS) {
    const p: string = await f.getFunction("getPool")(a, b, fee);
    if (p !== ethers.ZeroAddress) out.push(fee);
  }
  return out;
}

/** Every ordered (buy tier, sell tier) pair × size; best gross first. Sizes doubling from `min` to `max`. */
export async function scan(provider: ethers.Provider, chain: ChainCfg, loanToken: string, midToken: string, min: bigint, max: bigint): Promise<Quote[]> {
  const tiers = await poolsFor(provider, chain, loanToken, midToken);
  const sizes: bigint[] = [];
  for (let s = min; s <= max; s *= 2n) sizes.push(s);
  const out: Quote[] = [];
  for (const buyFee of tiers) {
    for (const sellFee of tiers) {
      if (buyFee === sellFee) continue;
      for (const amount of sizes) {
        const q = await quote(provider, chain, { loanToken, midToken, amount, buyFee, sellFee });
        if (q) out.push(q);
      }
    }
  }
  return out.sort((a, b) => (b.gross > a.gross ? 1 : b.gross < a.gross ? -1 : 0));
}

export interface RouteArgs {
  loanToken: string;
  amount: bigint;
  midToken: string;
  buyRouter: string;
  buyFee: number;
  sellRouter: string;
  sellFee: number;
  minMidOut: bigint;
  minProfit: bigint;
  deadline: bigint;
}

/** On-chain guards from a quote: the buy leg may slip `slippageBps`, the whole route must clear `minProfit`. */
export function routeFrom(q: Quote, minProfit: bigint, slippageBps: number, nowSec: number, ttlSec = 120): RouteArgs {
  return {
    loanToken: q.loanToken,
    amount: q.amount,
    midToken: q.midToken,
    buyRouter: q.buy.router,
    buyFee: q.buy.fee,
    sellRouter: q.sell.router,
    sellFee: q.sell.fee,
    minMidOut: (q.midOut * BigInt(10_000 - slippageBps)) / 10_000n,
    minProfit,
    deadline: BigInt(nowSec + ttlSec),
  };
}

export interface Simulation {
  ok: boolean;
  profit?: bigint;
  gas?: bigint;
  /** decoded revert, e.g. NoProfit(…) */
  reason?: string;
}

export async function simulate(executor: ethers.Contract, owner: string, route: RouteArgs): Promise<Simulation> {
  try {
    const profit = (await executor.getFunction("execute").staticCall(route, { from: owner })) as bigint;
    const gas = await executor.getFunction("execute").estimateGas(route, { from: owner });
    return { ok: true, profit, gas };
  } catch (e) {
    return { ok: false, reason: revertReason(executor.interface, e) };
  }
}

export function revertReason(iface: ethers.Interface, e: unknown): string {
  const data = (e as { data?: string; info?: { error?: { data?: string } } })?.data ?? (e as any)?.info?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const d = iface.parseError(data);
      if (d) return `${d.name}(${d.args.map(String).join(", ")})`;
    } catch {
      /* not one of ours */
    }
  }
  return (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
}

/** Net of gas, in loan-token units when the loan token is WETH (gas is paid in ETH). */
export function netOfGas(gross: bigint, gasUnits: bigint, gasPriceWei: bigint, loanIsWeth: boolean): bigint | null {
  return loanIsWeth ? gross - gasUnits * gasPriceWei : null;
}

export async function tokenInfo(provider: ethers.Provider, token: string) {
  const c = new ethers.Contract(token, ERC20_ABI, provider);
  const [d, s] = await Promise.all([c.getFunction("decimals")().catch(() => 18n), c.getFunction("symbol")().catch(() => "?")]);
  return { decimals: Number(d), symbol: String(s) };
}
