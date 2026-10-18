/**
 * Any wallet's Uniswap v4 positions. The v4 PositionManager can't enumerate an owner's NFTs, so
 * the token ids come from its Transfer logs (in − out, then ownerOf to confirm). Each position's
 * pool key and range come from the PositionManager, the price and fees from StateView.
 *
 * Output is the v3 position shape, with native ETH reported as the chain's WETH (same price), so
 * v3Rows values v4 exactly like v3: in ETH for ETH pairs, in USD for known stablecoin pairs.
 */
import { ethers } from "ethers";
import { SqrtPriceMath, TickMath } from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import { mapLimited, MAX_IDS, READ_CONCURRENCY, type V3Chain, type V3Position } from "./univ3";

export interface V4Chain extends V3Chain {
  /** the v4 PositionManager (overrides the v3 one of the same chain) */
  positionManager: string;
  stateView: string;
  /** widest eth_getLogs block range the RPC accepts */
  logRange: number;
}

const KEY = "tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const POSM_ABI = [
  `function getPoolAndPositionInfo(uint256 tokenId) view returns (${KEY} poolKey, uint256 info)`,
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function ownerOf(uint256 tokenId) view returns (address)",
];
const SV_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256, uint256)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();
const M256 = 1n << 256n;

/** PositionInfo packs | 200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber |. */
export function unpackInfo(info: bigint): { tickLower: number; tickUpper: number } {
  const int24 = (v: bigint) => Number(BigInt.asIntN(24, v & 0xffffffn));
  return { tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
}

/** Uncollected fees from fee growth: (inside now − inside at last touch) × L / 2^128, wrapping like the contract. */
export function feesOwed(liquidity: bigint, insideNow: bigint, insideLast: bigint): bigint {
  return ((((insideNow - insideLast) % M256) + M256) % M256 * liquidity) >> 128n;
}

/**
 * Token amounts of `liquidity` over [tickLower, tickUpper) at the current price: the v3 formula.
 * (The v3 SDK's Position also insists the ticks fit a v3 fee tier's spacing, which v4 pools don't.)
 */
export function amountsFor(liquidity: bigint, sqrtPriceX96: bigint, tick: number, tickLower: number, tickUpper: number): { amount0: bigint; amount1: bigint } {
  const L = JSBI.BigInt(liquidity.toString());
  const a = TickMath.getSqrtRatioAtTick(tickLower);
  const b = TickMath.getSqrtRatioAtTick(tickUpper);
  const p = JSBI.BigInt(sqrtPriceX96.toString());
  const big = (x: JSBI) => BigInt(x.toString());
  if (tick < tickLower) return { amount0: big(SqrtPriceMath.getAmount0Delta(a, b, L, false)), amount1: 0n };
  if (tick < tickUpper) return { amount0: big(SqrtPriceMath.getAmount0Delta(p, b, L, false)), amount1: big(SqrtPriceMath.getAmount1Delta(a, p, L, false)) };
  return { amount0: 0n, amount1: big(SqrtPriceMath.getAmount1Delta(a, b, L, false)) };
}

/** NFT ids the owner holds, from Transfer logs. */
export async function ownedIds(chain: V4Chain, owner: string, provider: ethers.Provider): Promise<bigint[]> {
  const head = await provider.getBlockNumber();
  const who = ethers.zeroPadValue(ethers.getAddress(owner), 32);
  const held = new Map<string, number>();
  for (let from = 0; from <= head; from += chain.logRange) {
    const to = Math.min(head, from + chain.logRange - 1);
    const [incoming, outgoing] = await Promise.all([
      provider.getLogs({ address: chain.positionManager, topics: [TRANSFER, null, who], fromBlock: from, toBlock: to }),
      provider.getLogs({ address: chain.positionManager, topics: [TRANSFER, who], fromBlock: from, toBlock: to }),
    ]);
    for (const l of incoming) held.set(l.topics[3]!, (held.get(l.topics[3]!) ?? 0) + 1);
    for (const l of outgoing) held.set(l.topics[3]!, (held.get(l.topics[3]!) ?? 0) - 1);
  }
  const posm = new ethers.Contract(chain.positionManager, POSM_ABI, provider);
  // newest first (higher ids are newer), capped like the v3 reader: bots cycle through hundreds
  const ids = [...held].filter(([, n]) => n > 0).map(([t]) => BigInt(t)).sort((a, b) => (b > a ? 1 : -1)).slice(0, MAX_IDS);
  // a burned id reverts; anything else (a rate limit, a timeout) must not read as "not yours", so
  // it's rethrown for mapLimited's retry
  const owners = await mapLimited(ids, READ_CONCURRENCY, (id) =>
    (posm.getFunction("ownerOf")(id) as Promise<string>).catch((e: unknown) => {
      if ((e as { code?: string })?.code === "CALL_EXCEPTION") return ethers.ZeroAddress;
      throw e;
    }),
  );
  return ids.filter((_, i) => owners[i]!.toLowerCase() === owner.toLowerCase());
}

export async function readV4Positions(chain: V4Chain, owner: string, provider: ethers.Provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true })): Promise<V3Position[]> {
  const posm = new ethers.Contract(chain.positionManager, POSM_ABI, provider);
  const sv = new ethers.Contract(chain.stateView, SV_ABI, provider);
  const meta = new Map<string, Promise<{ decimals: number; symbol: string }>>();
  const tokenMeta = (addr: string) => {
    const k = addr.toLowerCase();
    if (!meta.has(k)) {
      if (addr === ethers.ZeroAddress) meta.set(k, Promise.resolve({ decimals: 18, symbol: "ETH" }));
      else {
        const c = new ethers.Contract(addr, ERC20_ABI, provider);
        meta.set(k, Promise.all([c.getFunction("decimals")().catch(() => 18n), c.getFunction("symbol")().catch(() => "?")]).then(([d, s]) => ({ decimals: Number(d), symbol: String(s).slice(0, 16) })));
      }
    }
    return meta.get(k)!;
  };
  const ids = await ownedIds(chain, owner, provider);
  // liquidity first: an emptied v4 position holds no fees (v4 pays them out on every liquidity
  // change), so only live ones get the full read
  const liq = await mapLimited(ids, READ_CONCURRENCY, async (id) => BigInt(await posm.getFunction("getPositionLiquidity")(id)));
  const live = ids.filter((_, i) => liq[i]! > 0n);
  const read = async (id: bigint): Promise<V3Position> => {
    const liquidity = liq[ids.indexOf(id)]!;
    const [pk, info] = (await posm.getFunction("getPoolAndPositionInfo")(id)) as [ethers.Result, bigint];
    const key = { currency0: String(pk[0]), currency1: String(pk[1]), fee: Number(pk[2]), tickSpacing: Number(pk[3]), hooks: String(pk[4]) };
    const poolId = ethers.keccak256(coder.encode([KEY], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]));
    const { tickLower, tickUpper } = unpackInfo(BigInt(info));
    const salt = ethers.zeroPadValue(ethers.toBeHex(id), 32);
    const [slot0, inside, last, m0, m1] = await Promise.all([
      sv.getFunction("getSlot0")(poolId),
      sv.getFunction("getFeeGrowthInside")(poolId, tickLower, tickUpper),
      sv.getFunction("getPositionInfo")(poolId, chain.positionManager, tickLower, tickUpper, salt),
      tokenMeta(key.currency0),
      tokenMeta(key.currency1),
    ]);
    const fees0 = feesOwed(liquidity, BigInt(inside[0]), BigInt(last[1]));
    const fees1 = feesOwed(liquidity, BigInt(inside[1]), BigInt(last[2]));
    // native ETH as WETH: same price, and lets the v3 valuation treat both alike
    const addr0 = key.currency0 === ethers.ZeroAddress ? chain.weth : key.currency0;
    const sqrt = BigInt(slot0[0]);
    const { amount0, amount1 } = amountsFor(liquidity, sqrt, Number(slot0[1]), tickLower, tickUpper);
    return {
      tokenId: `v4:${id}`,
      token0: addr0,
      token1: key.currency1,
      symbol0: m0.symbol,
      symbol1: m1.symbol,
      decimals0: m0.decimals,
      decimals1: m1.decimals,
      fee: key.fee >= 0x800000 ? 0 : key.fee, // a dynamic-fee pool (hook-set fee) has no fixed tier to show
      tickLower,
      tickUpper,
      tick: Number(slot0[1]),
      liquidity,
      amount0,
      amount1,
      fees0,
      fees1,
      sqrtPriceX96: sqrt,
    };
  };
  return mapLimited(live, READ_CONCURRENCY, read);
}
