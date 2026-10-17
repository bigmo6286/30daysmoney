/**
 * Pool scanner. Finds pools by recent swap activity (factories on busy chains hold tens of
 * thousands of dead spam pools, so indexing PoolCreated doesn't scale), keeps the ones that are
 * WETH pairs from our factory, then on each scan reads fee growth for the deep ones. Between two scans, the growth in feeGrowthGlobal tells exactly what a position
 * in range earned per unit of liquidity, so we can price the yield for OUR position size and
 * width instead of guessing from volume.
 *
 * Uniswap v4 pools (one PoolManager, Swap events keyed by pool id) are indexed alongside: only
 * native-ETH pools without hooks, the same subset the bot trades. Their state is read through
 * StateView, and the same fee-growth method prices their yield.
 */
import path from "node:path";
import { ethers } from "ethers";
import { Position } from "@uniswap/v3-sdk";
import { Position as V4Position } from "@uniswap/v4-sdk";
import { poolIdOf, rememberV4Key, STATE_VIEW_ABI, unsupportedReason, v4Depth, V4_POSM_ABI, type V4Key } from "../chain/v4";
import { v4SdkPool } from "../lp/v4";
import type { Chain } from "../chain/client";
import { ERC20_ABI, POOL_ABI } from "../chain/abis";
import { multicall } from "../chain/multicall";
import { sdkPool, type PoolView } from "../chain/pools";
import { tokenMeta } from "../chain/tokens";
import { computeRange, tokenShareForRange } from "../core/range";
import { feesFromGrowth, priceE18FromSqrt, tokenToQuote } from "../core/pnl";
import type { Settings } from "../config";
import { readJson, writeJsonAtomic } from "../store";
import { logger } from "../log";

const log = logger("scanner");
const poolIface = new ethers.Interface(POOL_ABI);
const ercIface = new ethers.Interface(ERC20_ABI);
const SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V4_SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const svIface = new ethers.Interface(STATE_VIEW_ABI);
const posmIface = new ethers.Interface(V4_POSM_ABI);
const metaIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);
const MAX_CHUNK = Number(process.env.LOG_CHUNK_BLOCKS) || 5_000;
/** forget pools with no swap for this long */
const STALE_MS = 24 * 3_600_000;

interface IndexedPool {
  /** v3: pool contract · v4: pool id */
  pool: string;
  version?: 4;
  key?: V4Key;
  token: string;
  fee: number;
  tickSpacing: number;
}

interface Snapshot {
  ts: number;
  tick: number;
  g0: string;
  g1: string;
}

export interface Candidate {
  /** v3: pool contract · v4: pool id */
  pool: string;
  version?: 4;
  token: string;
  symbol: string;
  fee: number;
  depthWei: bigint;
  priceE18: bigint;
  /** last-interval and smoothed fee APR (%) for a position of autoSizeEth at widthPct */
  aprPct: number;
  aprEmaPct: number;
  /** price change over the last interval, % */
  movePct: number;
  /** swaps seen since the previous scan */
  swaps: number;
  samples: number;
  updatedAt: number;
}

interface ScannerFile {
  lastBlock: number;
  /** verified WETH pools from our factory, with last time a swap was seen */
  pools: (IndexedPool & { lastSwapAt: number; swaps: number })[];
  /** addresses already checked and rejected (other factory / not WETH) */
  rejected: Record<string, true>;
  snaps: Record<string, Snapshot>;
  stats: Record<string, { aprEmaPct: number; samples: number }>;
}

export class Scanner {
  private file: string;
  private data: ScannerFile;
  private results = new Map<string, Candidate>();
  lastScanAt = 0;

  constructor(
    private readonly chain: Chain,
    private readonly settings: () => Settings,
    dataDir: string,
  ) {
    this.file = path.join(dataDir, "scanner.json");
    this.data = readJson<ScannerFile>(this.file, { lastBlock: -1, pools: [], rejected: {}, snaps: {}, stats: {} });
  }

  get indexedCount() {
    return this.data.pools.length;
  }

  /** Read Swap events since the last scan; verify and remember new WETH pools from our factory. */
  async refreshIndex(): Promise<void> {
    const v4 = this.chain.cfg.chain.v4;
    const head = await this.chain.logsProvider.getBlockNumber();
    const lookbackBlocks = Number(process.env.SCAN_LOOKBACK_BLOCKS) || 30_000;
    let from = Math.max(this.data.lastBlock + 1, head - lookbackBlocks);
    let chunk = MAX_CHUNK;
    const counts = new Map<string, number>();
    while (from <= head) {
      const to = Math.min(from + chunk - 1, head);
      let logs: ethers.Log[];
      try {
        // one query for both: v3 Swaps come from each pool, v4 Swaps from the PoolManager (topic 1 = pool id)
        logs = await this.chain.logsProvider.getLogs({ topics: [v4 ? [SWAP_TOPIC, V4_SWAP_TOPIC] : SWAP_TOPIC], fromBlock: from, toBlock: to });
      } catch (e) {
        log.debug(`getLogs ${from}-${to} failed: ${(e as Error).message.slice(0, 120)}`);
        // providers cap results/ranges per query: shrink the window and retry
        if (chunk > 50) {
          chunk = Math.floor(chunk / 2);
          continue;
        }
        throw e;
      }
      for (const l of logs) {
        const k = l.topics[0] === V4_SWAP_TOPIC ? (l.address.toLowerCase() === v4?.poolManager.toLowerCase() ? l.topics[1]! : null) : l.address;
        if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      this.data.lastBlock = to;
      from = to + 1;
      chunk = Math.min(chunk * 2, MAX_CHUNK);
    }

    const now = Date.now();
    const known = new Map(this.data.pools.map((p) => [p.pool.toLowerCase(), p]));
    const unseen = [...counts.keys()].filter((a) => !known.has(a.toLowerCase()) && !this.data.rejected[a.toLowerCase()]);
    const fresh = unseen.filter((a) => a.length === 42);
    const freshV4 = unseen.filter((a) => a.length === 66);
    if (freshV4.length && v4) {
      const before = this.data.pools.length;
      // the PositionManager stores the key of every pool that has a position; pools without one can't be ours anyway
      const raw = await multicall(this.chain, freshV4.map((id) => ({ target: v4.positionManager, data: posmIface.encodeFunctionData("poolKeys", [id.slice(0, 52)]) })));
      freshV4.forEach((id, i) => {
        const r = raw[i] ? posmIface.decodeFunctionResult("poolKeys", raw[i]!) : null;
        const key: V4Key | null = r ? { currency0: r[0], currency1: r[1], fee: Number(r[2]), tickSpacing: Number(r[3]), hooks: r[4] } : null;
        if (!key || poolIdOf(key).toLowerCase() !== id.toLowerCase() || unsupportedReason(key)) {
          this.data.rejected[id.toLowerCase()] = true;
          return;
        }
        rememberV4Key(key);
        const p = { pool: id.toLowerCase(), version: 4 as const, key, token: ethers.getAddress(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, lastSwapAt: now, swaps: 0 };
        this.data.pools.push(p);
        known.set(p.pool, p);
      });
      if (this.data.pools.length > before) log.info(`tracking ${this.data.pools.length} active ETH pools (+${this.data.pools.length - before} v4)`);
    }
    if (fresh.length) {
      const before = this.data.pools.length;
      const fns = ["factory", "token0", "token1", "fee", "tickSpacing"] as const;
      const raw = await multicall(this.chain, fresh.flatMap((a) => fns.map((f) => ({ target: a, data: metaIface.encodeFunctionData(f) }))));
      const factory = this.chain.contracts.factory.toLowerCase();
      const weth = this.chain.contracts.weth.toLowerCase();
      fresh.forEach((addr, i) => {
        const r = raw.slice(i * 5, i * 5 + 5);
        // a contract that emits a Swap-shaped log but isn't a pool can answer with empty data (a
        // fallback function): that must reject this one address, not abort the whole index
        const dec = (f: (typeof fns)[number], x: string | null) => {
          try {
            return x ? metaIface.decodeFunctionResult(f, x)[0] : null;
          } catch {
            return null;
          }
        };
        const fac = dec("factory", r[0]!);
        const t0 = dec("token0", r[1]!);
        const t1 = dec("token1", r[2]!);
        const ok = fac && String(fac).toLowerCase() === factory && t0 && t1 &&
          (String(t0).toLowerCase() === weth || String(t1).toLowerCase() === weth);
        if (!ok) {
          this.data.rejected[addr.toLowerCase()] = true;
          return;
        }
        const p = {
          pool: ethers.getAddress(addr),
          token: ethers.getAddress(String(t0).toLowerCase() === weth ? String(t1) : String(t0)),
          fee: Number(dec("fee", r[3]!)),
          tickSpacing: Number(dec("tickSpacing", r[4]!)),
          lastSwapAt: now,
          swaps: 0,
        };
        this.data.pools.push(p);
        known.set(addr.toLowerCase(), p);
      });
      if (this.data.pools.length > before) log.info(`tracking ${this.data.pools.length} active WETH pools (+${this.data.pools.length - before})`);
    }
    for (const [addr, n] of counts) {
      const p = known.get(addr.toLowerCase());
      if (p) {
        p.lastSwapAt = now;
        p.swaps = n;
      }
    }
    const counted = new Set([...counts.keys()].map((k) => k.toLowerCase()));
    for (const p of this.data.pools) if (!counted.has(p.pool.toLowerCase())) p.swaps = 0;
    this.data.pools = this.data.pools.filter((p) => now - p.lastSwapAt < STALE_MS);
    this.save();
  }

  private save() {
    writeJsonAtomic(this.file, this.data);
  }

  /** One scan: depth filter, fee-growth snapshot, yield estimate. */
  async scan(): Promise<Candidate[]> {
    await this.refreshIndex();
    const set = this.settings();
    const weth = this.chain.contracts.weth;
    const minDepth = ethers.parseEther(String(set.autoMinDepthEth));
    const v3pools = this.data.pools.filter((p) => p.version !== 4);
    const depths = await multicall(
      this.chain,
      v3pools.map((p) => ({ target: weth, data: ercIface.encodeFunctionData("balanceOf", [p.pool]) })),
    );
    const deep = v3pools
      .map((p, i) => ({ p, depth: depths[i] ? BigInt(depths[i]!) : 0n }))
      .filter((x) => x.depth >= minDepth);

    const fns = ["slot0", "liquidity", "feeGrowthGlobal0X128", "feeGrowthGlobal1X128"] as const;
    const raw = await multicall(
      this.chain,
      deep.flatMap(({ p }) => fns.map((f) => ({ target: p.pool, data: poolIface.encodeFunctionData(f) }))),
    );
    const now = Date.now();
    const seen = new Set<string>();
    for (let i = 0; i < deep.length; i++) {
      const { p, depth } = deep[i]!;
      const r = raw.slice(i * 4, i * 4 + 4);
      if (r.some((x) => x === null)) continue;
      seen.add(p.pool);
      const slot0 = poolIface.decodeFunctionResult("slot0", r[0]!);
      const sqrtPriceX96 = BigInt(slot0[0]);
      const tick = Number(slot0[1]);
      const liquidity = BigInt(poolIface.decodeFunctionResult("liquidity", r[1]!)[0]);
      const g0 = BigInt(poolIface.decodeFunctionResult("feeGrowthGlobal0X128", r[2]!)[0]);
      const g1 = BigInt(poolIface.decodeFunctionResult("feeGrowthGlobal1X128", r[3]!)[0]);
      if (liquidity === 0n) continue;

      let token;
      try {
        token = await tokenMeta(this.chain, p.token);
      } catch {
        continue;
      }
      const quote = { address: ethers.getAddress(weth), symbol: "WETH", decimals: 18 };
      const quoteIsToken0 = weth.toLowerCase() < p.token.toLowerCase();
      const priceE18 = priceE18FromSqrt(sqrtPriceX96, quoteIsToken0, token.decimals);
      const prev = this.data.snaps[p.pool];
      this.data.snaps[p.pool] = { ts: now, tick, g0: g0.toString(), g1: g1.toString() };
      const stat = this.data.stats[p.pool] ?? { aprEmaPct: 0, samples: 0 };
      let aprPct = 0;
      let movePct = 0;
      if (prev && now - prev.ts >= 30_000 && priceE18 > 0n) {
        const view: PoolView = {
          address: p.pool, fee: p.fee, tickSpacing: p.tickSpacing,
          token0: quoteIsToken0 ? quote.address : token.address,
          token1: quoteIsToken0 ? token.address : quote.address,
          sqrtPriceX96, tick, liquidity, feeGrowthGlobal0X128: g0, feeGrowthGlobal1X128: g1,
          token, quote, quoteIsToken0, priceE18, quoteReserve: depth,
        };
        aprPct = this.positionApr(view, BigInt(prev.g0), BigInt(prev.g1), now - prev.ts, set);
        const tokenPriceMove = Math.pow(1.0001, quoteIsToken0 ? prev.tick - tick : tick - prev.tick) - 1;
        movePct = tokenPriceMove * 100;
        stat.aprEmaPct = stat.samples === 0 ? aprPct : stat.aprEmaPct * 0.6 + aprPct * 0.4;
        stat.samples++;
        this.data.stats[p.pool] = stat;
      }
      this.results.set(p.pool, {
        pool: p.pool, token: token.address, symbol: token.symbol, fee: p.fee, depthWei: depth, priceE18,
        aprPct, aprEmaPct: stat.aprEmaPct, movePct, swaps: p.swaps, samples: stat.samples, updatedAt: now,
      });
    }
    await this.scanV4(seen, now, minDepth, set);
    for (const k of [...this.results.keys()]) if (!seen.has(k)) this.results.delete(k);
    this.lastScanAt = now;
    this.save();
    return this.ranked();
  }

  /** v4 half of a scan: StateView reads, depth = ETH side of the active liquidity, same yield method. */
  private async scanV4(seen: Set<string>, now: number, minDepth: bigint, set: Settings) {
    const v4 = this.chain.cfg.chain.v4;
    // the configured fee tiers only, as for a pasted token: v4 also has 0%-fee pools, where an LP earns nothing
    const pools = this.data.pools.filter((p) => p.version === 4 && p.key && set.feeTiers.includes(p.fee));
    if (!v4 || !pools.length) return;
    const fns = ["getSlot0", "getLiquidity", "getFeeGrowthGlobals"] as const;
    const raw = await multicall(this.chain, pools.flatMap((p) => fns.map((f) => ({ target: v4.stateView, data: svIface.encodeFunctionData(f, [p.pool]) }))));
    const quote = { address: ethers.ZeroAddress, symbol: "ETH", decimals: 18 };
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i]!;
      const r = raw.slice(i * 3, i * 3 + 3);
      if (r.some((x) => x === null)) continue;
      const slot0 = svIface.decodeFunctionResult("getSlot0", r[0]!);
      const sqrtPriceX96 = BigInt(slot0[0]);
      const tick = Number(slot0[1]);
      const liquidity = BigInt(svIface.decodeFunctionResult("getLiquidity", r[1]!)[0]);
      const g = svIface.decodeFunctionResult("getFeeGrowthGlobals", r[2]!);
      if (liquidity === 0n || sqrtPriceX96 === 0n) continue;
      const depth = v4Depth(liquidity, sqrtPriceX96);
      if (depth < minDepth) continue;
      let token;
      try {
        token = await tokenMeta(this.chain, p.token);
      } catch {
        continue;
      }
      seen.add(p.pool);
      const [g0, g1] = [BigInt(g[0]), BigInt(g[1])];
      const priceE18 = priceE18FromSqrt(sqrtPriceX96, true, token.decimals);
      const prev = this.data.snaps[p.pool];
      this.data.snaps[p.pool] = { ts: now, tick, g0: g0.toString(), g1: g1.toString() };
      const stat = this.data.stats[p.pool] ?? { aprEmaPct: 0, samples: 0 };
      let aprPct = 0;
      let movePct = 0;
      if (prev && now - prev.ts >= 30_000 && priceE18 > 0n) {
        const view: PoolView = {
          address: p.pool, version: 4, v4Key: p.key, fee: p.fee, tickSpacing: p.tickSpacing,
          token0: ethers.ZeroAddress, token1: token.address,
          sqrtPriceX96, tick, liquidity, feeGrowthGlobal0X128: g0, feeGrowthGlobal1X128: g1,
          token, quote, quoteIsToken0: true, priceE18, quoteReserve: depth,
        };
        aprPct = this.positionApr(view, BigInt(prev.g0), BigInt(prev.g1), now - prev.ts, set);
        movePct = (Math.pow(1.0001, prev.tick - tick) - 1) * 100; // ETH is token0: token price ∝ 1.0001^-tick
        stat.aprEmaPct = stat.samples === 0 ? aprPct : stat.aprEmaPct * 0.6 + aprPct * 0.4;
        stat.samples++;
        this.data.stats[p.pool] = stat;
      }
      this.results.set(p.pool, {
        pool: p.pool, version: 4, token: token.address, symbol: token.symbol, fee: p.fee, depthWei: depth, priceE18,
        aprPct, aprEmaPct: stat.aprEmaPct, movePct, swaps: p.swaps, samples: stat.samples, updatedAt: now,
      });
    }
  }

  /** Fee APR (%) a fresh in-range position of autoSizeEth at widthPct would have earned over the interval. */
  private positionApr(v: PoolView, prevG0: bigint, prevG1: bigint, dtMs: number, set: Settings): number {
    const size = ethers.parseEther(String(set.autoSizeEth));
    const range = computeRange("inrange", { tick: v.tick, tickSpacing: v.tickSpacing, quoteIsToken0: v.quoteIsToken0, widthPct: set.widthPct, singleOffsetPct: set.singleOffsetPct });
    const share = tokenShareForRange(v.tick, range, v.quoteIsToken0);
    const tokenEth = (size * BigInt(Math.round(share * 1e6))) / 1_000_000n;
    const tokenAmt = (tokenEth * 10n ** BigInt(v.token.decimals)) / v.priceE18;
    const quoteAmt = size - tokenEth;
    let L: bigint;
    try {
      const amounts = {
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount0: (v.quoteIsToken0 ? quoteAmt : tokenAmt).toString(),
        amount1: (v.quoteIsToken0 ? tokenAmt : quoteAmt).toString(),
        useFullPrecision: true,
      };
      const pos = v.version === 4
        ? V4Position.fromAmounts({ pool: v4SdkPool(this.chain, v).pool, ...amounts })
        : Position.fromAmounts({ pool: sdkPool(this.chain.cfg.chain.chainId, v), ...amounts });
      L = BigInt(pos.liquidity.toString());
    } catch {
      return 0;
    }
    const f0 = feesFromGrowth(L, prevG0, v.feeGrowthGlobal0X128);
    const f1 = feesFromGrowth(L, prevG1, v.feeGrowthGlobal1X128);
    const feeQuote = v.quoteIsToken0 ? f0 : f1;
    const feeToken = v.quoteIsToken0 ? f1 : f0;
    const earned = feeQuote + tokenToQuote(feeToken, v.priceE18, v.token.decimals);
    const perYear = (Number(earned) / Number(size)) * ((365 * 24 * 3_600_000) / dtMs);
    return perYear * 100;
  }

  ranked(): Candidate[] {
    return [...this.results.values()].sort((a, b) => b.aprEmaPct - a.aprEmaPct);
  }

  get(pool: string): Candidate | undefined {
    return this.results.get(pool);
  }
}
