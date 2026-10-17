/**
 * Uniswap v4: pools live inside one PoolManager and are named by a PoolKey (its hash is the
 * pool id). We only use native-ETH / token pools without hooks: ETH is the bot's quote currency,
 * and a hook is arbitrary code that runs on every swap and liquidity change.
 *
 * Reads go through StateView, quotes through V4Quoter, swaps through the UniversalRouter
 * (V4_SWAP) and positions through the v4 PositionManager. Both pull ERC-20s via Permit2, so a
 * token side needs two exact approvals: token → Permit2, then Permit2 → spender.
 */
import { ethers } from "ethers";
import type { Chain } from "./client";
import type { V4Contracts } from "../chains";
import { tokenMeta, type TokenMeta } from "./tokens";
import { priceE18FromSqrt } from "../core/pnl";
import type { PoolView } from "./pools";

export interface V4Key {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** fee / tick-spacing pairs we look for when a token is pasted (Uniswap's defaults + one seen live) */
export const V4_TIERS: [fee: number, tickSpacing: number][] = [
  [100, 1],
  [500, 10],
  [500, 1],
  [3000, 60],
  [10000, 200],
];

export const NATIVE = ethers.ZeroAddress;
const KEY_TUPLE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const keyArr = (k: V4Key) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

export const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getFeeGrowthGlobals(bytes32 poolId) view returns (uint256, uint256)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
];
export const V4_QUOTER_ABI = [`function quoteExactInputSingle((${KEY_TUPLE} poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)`];
export const V4_POSM_ABI = [
  `function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)`,
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function ownerOf(uint256) view returns (address)",
  "function nextTokenId() view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed id)",
];
export const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
export const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];

const coder = ethers.AbiCoder.defaultAbiCoder();

export function poolIdOf(k: V4Key): string {
  return ethers.keccak256(coder.encode([KEY_TUPLE], [keyArr(k)]));
}

export const isPoolId = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);

/**
 * Depth of a native-ETH v4 pool: the ETH it takes to push the token price 10% at the current
 * liquidity, Δx = L·(1/√P − 1/√(1.1·P)). A v4 pool has no balance of its own to read, and the
 * whole virtual reserve (L/√P) is useless as a gate: liquidity packed into a narrow range makes it
 * astronomically large. This still assumes L holds over the band; the round-trip quote is the
 * real check on price impact.
 */
export function v4Depth(liquidity: bigint, sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const virtual = (liquidity << 96n) / sqrtPriceX96;
  return (virtual * 4654n) / 100_000n; // 1 − 1/√1.1 = 0.04654
}

export function v4Of(chain: Chain): V4Contracts {
  const v4 = chain.cfg.chain.v4;
  if (!v4) throw new Error(`Uniswap v4 is not configured for ${chain.cfg.chain.name}`);
  return v4;
}

/** id → key for pools we've seen (the PositionManager also knows every pool that has a position) */
const keys = new Map<string, V4Key>();

export function rememberV4Key(k: V4Key) {
  keys.set(poolIdOf(k).toLowerCase(), k);
}

export async function keyOf(chain: Chain, id: string): Promise<V4Key> {
  const known = keys.get(id.toLowerCase());
  if (known) return known;
  const posm = new ethers.Contract(v4Of(chain).positionManager, V4_POSM_ABI, chain.provider);
  const r = await posm.getFunction("poolKeys")(id.slice(0, 52)); // bytes25: the first 25 bytes of the id
  const k: V4Key = { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] };
  if (k.currency0 === NATIVE && k.currency1 === NATIVE) throw new Error(`unknown v4 pool ${id}`);
  if (poolIdOf(k).toLowerCase() !== id.toLowerCase()) throw new Error(`v4 pool id ${id} doesn't match its key`);
  keys.set(id.toLowerCase(), k);
  return k;
}

/** Why the bot won't use this v4 pool, or null. */
export function unsupportedReason(k: V4Key): string | null {
  if (k.hooks !== NATIVE) return "pool has a hook contract (arbitrary code on every swap); not supported";
  if (k.currency0 !== NATIVE) return "not a native-ETH pool";
  if (k.fee >= 0x800000) return "dynamic-fee pool; not supported";
  return null;
}

export async function readV4PoolView(chain: Chain, idOrKey: string | V4Key): Promise<PoolView> {
  const key = typeof idOrKey === "string" ? await keyOf(chain, idOrKey) : idOrKey;
  const bad = unsupportedReason(key);
  if (bad) throw new Error(bad);
  const id = poolIdOf(key);
  keys.set(id.toLowerCase(), key);
  const sv = new ethers.Contract(v4Of(chain).stateView, STATE_VIEW_ABI, chain.provider);
  const [slot0, liquidity, growth, token] = await Promise.all([
    sv.getFunction("getSlot0")(id),
    sv.getFunction("getLiquidity")(id),
    sv.getFunction("getFeeGrowthGlobals")(id),
    tokenMeta(chain, key.currency1),
  ]);
  const sqrtPriceX96 = BigInt(slot0[0]);
  if (sqrtPriceX96 === 0n) throw new Error("v4 pool not initialized");
  const quote: TokenMeta = { address: NATIVE, symbol: "ETH", decimals: 18 };
  const L = BigInt(liquidity);
  return {
    address: id,
    version: 4,
    v4Key: key,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    token0: NATIVE,
    token1: ethers.getAddress(key.currency1),
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity: L,
    feeGrowthGlobal0X128: BigInt(growth[0]),
    feeGrowthGlobal1X128: BigInt(growth[1]),
    token,
    quote,
    quoteIsToken0: true,
    priceE18: priceE18FromSqrt(sqrtPriceX96, true, token.decimals, 18),
    quoteReserve: v4Depth(L, sqrtPriceX96),
  };
}

/** Native-ETH, hookless v4 pools for `token` on the given fee tiers, with liquidity. */
export async function findV4Pools(chain: Chain, token: string, feeTiers: number[]): Promise<PoolView[]> {
  if (!chain.cfg.chain.v4) return [];
  const cands = V4_TIERS.filter(([fee]) => feeTiers.includes(fee)).map(([fee, tickSpacing]): V4Key => ({ currency0: NATIVE, currency1: ethers.getAddress(token), fee, tickSpacing, hooks: NATIVE }));
  const views = await Promise.all(cands.map((k) => readV4PoolView(chain, k).catch(() => null)));
  const live = views.filter((v): v is PoolView => !!v && v.liquidity > 0n);
  // some live pools can't be quoted at all (the quoter reverts NotEnoughLiquidity both ways); a pool
  // we can't price a tiny buy *and* sell on is one we might not get back out of, so skip it
  const probe = 10n ** 14n; // 0.0001 ETH
  const ok = await Promise.all(
    live.map(async (v) => {
      const bought = await quoteV4(chain, v.v4Key!, true, probe);
      return bought > 0n && (await quoteV4(chain, v.v4Key!, false, bought)) > 0n;
    }),
  );
  return live.filter((_, i) => ok[i]);
}

/** Exact-in quote on one v4 pool; 0 when it can't fill. zeroForOne = ETH → token. */
export async function quoteV4(chain: Chain, key: V4Key, zeroForOne: boolean, amountIn: bigint): Promise<bigint> {
  const q = new ethers.Contract(v4Of(chain).quoter, V4_QUOTER_ABI, chain.provider);
  try {
    const r = await q.getFunction("quoteExactInputSingle").staticCall({ poolKey: keyArr(key), zeroForOne, exactAmount: amountIn, hookData: "0x" });
    return BigInt(r[0]);
  } catch {
    return 0n;
  }
}

// UniversalRouter command + v4 router actions (v4-periphery Actions.sol)
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

/**
 * UniversalRouter.execute calldata for one exact-in swap on a v4 pool, output to the caller.
 * Uses the router ≥ 2.1.1 layout (minHopPriceX36 in the swap struct; 0 = no per-hop bound).
 */
export function encodeV4Swap(key: V4Key, zeroForOne: boolean, amountIn: bigint, minOut: bigint, deadline: number): string {
  const [cin, cout] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const actions = ethers.solidityPacked(["uint8", "uint8", "uint8"], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const params = [
    coder.encode([`tuple(${KEY_TUPLE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`], [[keyArr(key), zeroForOne, amountIn, minOut, 0n, "0x"]]),
    coder.encode(["address", "uint256"], [cin, amountIn]),
    coder.encode(["address", "uint256"], [cout, minOut]),
  ];
  const input = coder.encode(["bytes", "bytes[]"], [actions, params]);
  return new ethers.Interface(UR_ABI).encodeFunctionData("execute", [ethers.solidityPacked(["uint8"], [V4_SWAP]), [input], deadline]);
}

/** Uncollected fees of a PositionManager-owned position (the NFT id is the position's salt). */
export async function v4PositionFees(chain: Chain, poolId: string, tokenId: string, tickLower: number, tickUpper: number): Promise<{ liquidity: bigint; fee0: bigint; fee1: bigint }> {
  const v4 = v4Of(chain);
  const sv = new ethers.Contract(v4.stateView, STATE_VIEW_ABI, chain.provider);
  const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const [info, inside] = await Promise.all([
    sv.getFunction("getPositionInfo")(poolId, v4.positionManager, tickLower, tickUpper, salt),
    sv.getFunction("getFeeGrowthInside")(poolId, tickLower, tickUpper),
  ]);
  const L = BigInt(info[0]);
  const M = 1n << 256n;
  const owed = (now: bigint, last: bigint) => ((((now - last) % M) + M) % M * L) >> 128n;
  return { liquidity: L, fee0: owed(BigInt(inside[0]), BigInt(info[1])), fee1: owed(BigInt(inside[1]), BigInt(info[2])) };
}
