/**
 * Any wallet's Uniswap v3 positions, read from the NonfungiblePositionManager:
 * amounts at the current price (v3-sdk math) + unclaimed fees (a static `collect` call
 * from the owner, which counts fees accrued since the last poke), valued in ETH for
 * WETH pairs. Non-WETH pairs are listed but not valued.
 */
import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { Pool, Position } from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import type { Row } from "../model";

export interface V3Chain {
  name: string;
  chainId: number;
  rpcUrl: string;
  factory: string;
  positionManager: string;
  weth: string;
  /** dollar stablecoins on this chain: pairs quoted in one are valued in USD */
  stables?: { address: string; decimals: number }[];
}

const NPM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)", "function liquidity() view returns (uint128)"];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const MAX128 = (1n << 128n) - 1n;
const Q192 = 1n << 192n;

export interface V3Position {
  tokenId: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  fee: number;
  tickLower: number;
  tickUpper: number;
  tick: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
  sqrtPriceX96: bigint;
}

/** Value amounts of token0/token1 in WETH (wei), given the pool price. null when neither side is WETH. */
export function valueInWeth(p: Pick<V3Position, "token0" | "token1" | "sqrtPriceX96">, weth: string, a0: bigint, a1: bigint): bigint | null {
  const s2 = p.sqrtPriceX96 * p.sqrtPriceX96; // price of token0 in token1, × 2^192
  if (p.token0.toLowerCase() === weth.toLowerCase()) return a0 + (a1 * Q192) / s2;
  if (p.token1.toLowerCase() === weth.toLowerCase()) return a1 + (a0 * s2) / Q192;
  return null;
}

/** position NFTs read per wallet (newest first) */
const MAX_IDS = 200;
const READ_CONCURRENCY = 6;

const rateLimited = (e: unknown) => {
  const x = e as { info?: { error?: { code?: number } }; error?: { code?: number }; message?: string };
  return x?.info?.error?.code === 429 || x?.error?.code === 429 || /\b429\b|compute units per second|rate limit/i.test(x?.message ?? "");
};

/** Retry a read that hit a provider's rate limit (Alchemy's free tier caps compute units per second). */
async function withRetry<T>(f: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries - 1 || !rateLimited(e)) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i + Math.random() * 100));
    }
  }
}

/** f over items with at most `n` in flight, results in order. */
async function mapLimited<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await withRetry(() => f(items[i]!));
      }
    }),
  );
  return out;
}

export async function readV3Positions(chain: V3Chain, owner: string, provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true })): Promise<V3Position[]> {
  const npm = new ethers.Contract(chain.positionManager, NPM_ABI, provider);
  const factory = new ethers.Contract(chain.factory, FACTORY_ABI, provider);
  const n = Number(await withRetry(() => npm.getFunction("balanceOf")(owner)));
  // highest index first (roughly newest): bots that never burn pile up thousands of emptied NFTs (one live Robinhood wallet
  // holds ~15k), and the live positions are the recent ones
  const ids = await mapLimited(Array.from({ length: Math.min(n, MAX_IDS) }, (_, i) => n - 1 - i), READ_CONCURRENCY, (i) => npm.getFunction("tokenOfOwnerByIndex")(owner, i) as Promise<bigint>);
  const meta = new Map<string, { decimals: number; symbol: string }>();
  const tokenMeta = async (addr: string) => {
    const k = addr.toLowerCase();
    if (!meta.has(k)) {
      const c = new ethers.Contract(addr, ERC20_ABI, provider);
      const [d, s] = await Promise.all([c.getFunction("decimals")().catch(() => 18n), c.getFunction("symbol")().catch(() => "?")]);
      meta.set(k, { decimals: Number(d), symbol: String(s).slice(0, 16) });
    }
    return meta.get(k)!;
  };
  const read = async (id: bigint): Promise<V3Position | null> => {
    const p = await npm.getFunction("positions")(id);
    const [fees0, fees1] = (await npm.getFunction("collect").staticCall({ tokenId: id, recipient: owner, amount0Max: MAX128, amount1Max: MAX128 }, { from: owner })) as [bigint, bigint];
    const liquidity = BigInt(p.liquidity);
    if (liquidity === 0n && fees0 === 0n && fees1 === 0n) return null; // emptied position NFT
    const poolAddr: string = await factory.getFunction("getPool")(p.token0, p.token1, p.fee);
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const [slot0, poolLiq, m0, m1] = await Promise.all([pool.getFunction("slot0")(), pool.getFunction("liquidity")(), tokenMeta(p.token0), tokenMeta(p.token1)]);
    const t0 = new Token(chain.chainId, p.token0, m0.decimals, m0.symbol);
    const t1 = new Token(chain.chainId, p.token1, m1.decimals, m1.symbol);
    const sdkPool = new Pool(t0, t1, Number(p.fee), JSBI.BigInt(slot0.sqrtPriceX96.toString()), JSBI.BigInt(poolLiq.toString()), Number(slot0.tick));
    const pos = new Position({ pool: sdkPool, liquidity: JSBI.BigInt(liquidity.toString()), tickLower: Number(p.tickLower), tickUpper: Number(p.tickUpper) });
    return {
      tokenId: id.toString(),
      token0: p.token0,
      token1: p.token1,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      fee: Number(p.fee),
      tickLower: Number(p.tickLower),
      tickUpper: Number(p.tickUpper),
      tick: Number(slot0.tick),
      liquidity,
      amount0: BigInt(pos.amount0.quotient.toString()),
      amount1: BigInt(pos.amount1.quotient.toString()),
      fees0,
      fees1,
      sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
    };
  };
  // a few reads in flight at once: one at a time took 90 s for 200 NFTs; all at once trips rate limits
  const got = await mapLimited(ids, READ_CONCURRENCY, read);
  return got.filter((p): p is V3Position => p !== null);
}

/** The side positions are valued in: WETH first (ETH), else a known stablecoin (USD). */
export function quoteOf(chain: V3Chain, p: Pick<V3Position, "token0" | "token1">): { address: string; decimals: number; unit: "ETH" | "USD" } | null {
  const has = (a: string) => p.token0.toLowerCase() === a.toLowerCase() || p.token1.toLowerCase() === a.toLowerCase();
  if (has(chain.weth)) return { address: chain.weth, decimals: 18, unit: "ETH" };
  const s = chain.stables?.find((x) => has(x.address));
  return s ? { ...s, unit: "USD" } : null;
}

export function v3Rows(chain: V3Chain, owner: string, positions: V3Position[]): Row[] {
  return positions.map((p) => {
    const q = quoteOf(chain, p);
    const qa = q?.address ?? chain.weth;
    const scale = 10 ** (q?.decimals ?? 18);
    const value = q ? valueInWeth(p, qa, p.amount0 + p.fees0, p.amount1 + p.fees1) : null;
    const fees = q ? valueInWeth(p, qa, p.fees0, p.fees1) : null;
    const wethIs0 = p.token0.toLowerCase() === qa.toLowerCase();
    const oneToken = 10n ** BigInt(wethIs0 ? p.decimals1 : p.decimals0);
    const price = q ? valueInWeth(p, qa, wethIs0 ? 0n : oneToken, wethIs0 ? oneToken : 0n) : null;
    return {
      source: "wallet",
      chain: chain.name,
      wallet: owner,
      id: p.tokenId,
      pair: `${wethIs0 ? p.symbol1 : p.symbol0}/${wethIs0 ? p.symbol0 : p.symbol1} ${p.fee / 10_000}%`,
      status: "open",
      unit: q?.unit ?? "ETH",
      valueNative: value === null ? undefined : Number(value) / scale,
      feesNative: fees === null ? undefined : Number(fees) / scale,
      inRange: p.tick >= p.tickLower && p.tick < p.tickUpper,
      tokenPriceNative: price === null ? undefined : Number(price) / scale,
      note: value === null ? "neither WETH nor a known stablecoin: not valued" : undefined,
    } satisfies Row;
  });
}
