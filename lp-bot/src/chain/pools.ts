import { ethers } from "ethers";
import { Pool } from "@uniswap/v3-sdk";
import { FACTORY_ABI, POOL_ABI } from "./abis";
import type { Chain } from "./client";
import { erc20Balance, sdkToken, tokenMeta, type TokenMeta } from "./tokens";
import { priceE18FromSqrt } from "../core/pnl";

export interface PoolState {
  address: string;
  fee: number;
  tickSpacing: number;
  token0: string;
  token1: string;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
}

export interface PoolView extends PoolState {
  token: TokenMeta;
  quote: TokenMeta;
  quoteIsToken0: boolean;
  /** quote (wei) per whole token × 1e18 */
  priceE18: bigint;
  /** quote-side balance held by the pool, a quick depth signal */
  quoteReserve: bigint;
}

export async function readPoolState(chain: Chain, address: string): Promise<PoolState> {
  const p = new ethers.Contract(address, POOL_ABI, chain.provider);
  const f = (n: string) => p.getFunction(n)();
  const [slot0, liquidity, fee, spacing, token0, token1, g0, g1] = await Promise.all([
    f("slot0"),
    f("liquidity"),
    f("fee"),
    f("tickSpacing"),
    f("token0"),
    f("token1"),
    f("feeGrowthGlobal0X128"),
    f("feeGrowthGlobal1X128"),
  ]);
  return {
    address: ethers.getAddress(address),
    fee: Number(fee),
    tickSpacing: Number(spacing),
    token0: ethers.getAddress(token0),
    token1: ethers.getAddress(token1),
    sqrtPriceX96: BigInt(slot0[0]),
    tick: Number(slot0[1]),
    liquidity: BigInt(liquidity),
    feeGrowthGlobal0X128: BigInt(g0),
    feeGrowthGlobal1X128: BigInt(g1),
  };
}

export async function readPoolView(chain: Chain, address: string): Promise<PoolView> {
  const st = await readPoolState(chain, address);
  const weth = ethers.getAddress(chain.contracts.weth);
  const quoteIsToken0 = st.token0 === weth;
  if (!quoteIsToken0 && st.token1 !== weth) throw new Error("not a WETH pool");
  const [token, quote, quoteReserve] = await Promise.all([
    tokenMeta(chain, quoteIsToken0 ? st.token1 : st.token0),
    tokenMeta(chain, weth),
    erc20Balance(chain, weth, st.address),
  ]);
  return {
    ...st,
    token,
    quote,
    quoteIsToken0,
    priceE18: priceE18FromSqrt(st.sqrtPriceX96, quoteIsToken0, token.decimals, quote.decimals),
    quoteReserve,
  };
}

/** Every WETH pool for `token` across the configured fee tiers, deepest first. */
export async function findWethPools(chain: Chain, token: string, feeTiers: number[]): Promise<PoolView[]> {
  const factory = new ethers.Contract(chain.contracts.factory, FACTORY_ABI, chain.provider);
  const addrs = await Promise.all(
    feeTiers.map((fee) =>
      (factory.getFunction("getPool")(token, chain.contracts.weth, fee) as Promise<string>).catch(() => ethers.ZeroAddress),
    ),
  );
  const views = await Promise.all(
    addrs.filter((a) => a !== ethers.ZeroAddress).map((a) => readPoolView(chain, a).catch(() => null)),
  );
  return views
    .filter((v): v is PoolView => !!v && v.liquidity > 0n)
    .sort((a, b) => (b.quoteReserve > a.quoteReserve ? 1 : b.quoteReserve < a.quoteReserve ? -1 : 0));
}

export function sdkPool(chainId: number, v: PoolView): Pool {
  const t0 = sdkToken(chainId, v.quoteIsToken0 ? v.quote : v.token);
  const t1 = sdkToken(chainId, v.quoteIsToken0 ? v.token : v.quote);
  return new Pool(t0, t1, v.fee, v.sqrtPriceX96.toString(), v.liquidity.toString(), v.tick);
}
