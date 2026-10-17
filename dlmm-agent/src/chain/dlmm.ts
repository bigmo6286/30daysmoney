/**
 * Meteora DLMM through the official SDK. Two executors share one interface:
 *   PaperExecutor: reads the real pool, moves virtual positions with the real active bin, sends nothing
 *   LiveExecutor:  opens/closes real positions; every send goes through Solana.sendInstructions
 * Position value always comes from the chain (or the paper model), never from a third-party PnL API.
 */
import { createRequire } from "node:module";
import type DLMMClass from "@meteora-ag/dlmm";
import type { StrategyType as StrategyTypeEnum } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Settings } from "../config";
import type { PositionRec } from "../positions";
import { depthOf, paperValue, rangeState, solRange } from "../range";
import { WSOL } from "../auto/discovery";
import type { Jupiter } from "./jupiter";
import { shortErr, type Solana } from "./solana";
import { logger } from "../log";

// The SDK's ESM build imports an Anchor directory path that Node refuses to load
// ("Directory import ... is not supported"); its CommonJS build works. module.exports is the class.
const sdk = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof DLMMClass & { StrategyType: typeof StrategyTypeEnum };
const DLMM = sdk;
type DLMM = DLMMClass;
const StrategyType = sdk.StrategyType;

const log = logger("dlmm");
const TIMEFRAME_MS: Record<string, number> = { "5m": 3e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "12h": 432e5, "24h": 864e5 };

export interface PoolSnapshot {
  activeId: number;
  binStep: number;
  solIsX: boolean;
  mint: string;
  decimals: number;
  /** token price in SOL at the active bin */
  tokenPriceSol: number;
}

export interface PoolReader {
  read(pool: string): Promise<PoolSnapshot>;
}

export interface Opened {
  position: string;
  entryId: number;
  minBinId: number;
  maxBinId: number;
  spentSol: number;
}

export interface Valued {
  valueSol: number;
  feesSol: number;
  activeId: number;
}

export interface Executor {
  readonly paper: boolean;
  open(pool: string, snap: PoolSnapshot, sizeSol: number, bins: number, s: Settings): Promise<Opened>;
  value(rec: PositionRec, s: Settings): Promise<Valued>;
  /** returns SOL received back in the wallet */
  close(rec: PositionRec, s: Settings): Promise<number>;
}

const STRATEGY = { spot: StrategyType.Spot, curve: StrategyType.Curve, bidask: StrategyType.BidAsk } as const;

/** Live pool reads through the SDK, one cached DLMM instance per pool. */
export class SdkPools implements PoolReader {
  private cache = new Map<string, DLMM>();
  constructor(private readonly sol: Solana) {}

  async dlmm(pool: string): Promise<DLMM> {
    let d = this.cache.get(pool);
    if (!d) {
      d = await DLMM.create(this.sol.connection, new PublicKey(pool));
      this.cache.set(pool, d);
    } else {
      await d.refetchStates();
    }
    return d;
  }

  async read(pool: string): Promise<PoolSnapshot> {
    const d = await this.dlmm(pool);
    const active = await d.getActiveBin();
    const solIsX = d.tokenX.publicKey.toBase58() === WSOL;
    if (!solIsX && d.tokenY.publicKey.toBase58() !== WSOL) throw new Error("not a SOL pair");
    const token = solIsX ? d.tokenY : d.tokenX;
    const pxy = Number(active.pricePerToken); // token X priced in token Y
    return {
      activeId: active.binId,
      binStep: d.lbPair.binStep,
      solIsX,
      mint: token.publicKey.toBase58(),
      decimals: token.mint.decimals,
      tokenPriceSol: solIsX ? 1 / pxy : pxy,
    };
  }
}

export class PaperExecutor implements Executor {
  readonly paper = true;
  constructor(private readonly pools: PoolReader) {}

  async open(_pool: string, snap: PoolSnapshot, sizeSol: number, bins: number): Promise<Opened> {
    const r = solRange(snap.activeId, bins, snap.solIsX);
    return { position: `paper-${Date.now().toString(36)}`, entryId: snap.activeId, ...r, spentSol: sizeSol };
  }

  /** Price moves are real; fees are an estimate: the pool's fee/TVL rate, earned only while in range. */
  async value(rec: PositionRec, s: Settings): Promise<Valued> {
    const snap = await this.pools.read(rec.pool);
    const depth = depthOf(rec.entryId, snap.activeId, rec.solIsX);
    const valueSol = paperValue(rec.depositSol, rec.bins, depth, rec.binStep);
    const now = Date.now();
    const p = rec.paper ?? { feesSol: 0, at: rec.openedAt };
    if (rangeState(depth, rec.bins) === "in" && rec.feeTvlPct) {
      p.feesSol += valueSol * (rec.feeTvlPct / 100) * ((now - p.at) / (TIMEFRAME_MS[s.timeframe] ?? 144e5));
    }
    p.at = now;
    rec.paper = p;
    return { valueSol: valueSol + p.feesSol, feesSol: p.feesSol, activeId: snap.activeId };
  }

  async close(rec: PositionRec, s: Settings): Promise<number> {
    return (await this.value(rec, s)).valueSol;
  }
}

export class LiveExecutor implements Executor {
  readonly paper = false;
  constructor(
    private readonly sol: Solana,
    private readonly pools: SdkPools,
    private readonly jup: Jupiter,
  ) {}

  async open(pool: string, snap: PoolSnapshot, sizeSol: number, bins: number, s: Settings): Promise<Opened> {
    const d = await this.pools.dlmm(pool);
    const r = solRange(snap.activeId, bins, snap.solIsX);
    const lamports = new BN(Math.floor(sizeSol * 1e9));
    const kp = Keypair.generate();
    const tx = await d.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: kp.publicKey,
      user: this.sol.address,
      totalXAmount: snap.solIsX ? lamports : new BN(0),
      totalYAmount: snap.solIsX ? new BN(0) : lamports,
      strategy: { ...r, strategyType: STRATEGY[s.strategy], ...(snap.solIsX ? { singleSidedX: true } : {}) },
      slippage: s.slippagePct,
    });
    const before = await this.sol.balanceSol();
    await this.sol.sendInstructions(tx.instructions, [kp], s.priorityMicroLamports);
    const after = await this.sol.balanceSol();
    return { position: kp.publicKey.toBase58(), entryId: snap.activeId, ...r, spentSol: before - after };
  }

  async value(rec: PositionRec): Promise<Valued> {
    const d = await this.pools.dlmm(rec.pool);
    const [pos, active] = await Promise.all([d.getPosition(new PublicKey(rec.position)), d.getActiveBin()]);
    const pd = pos.positionData;
    const token = rec.solIsX ? d.tokenY : d.tokenX;
    const pxy = Number(active.pricePerToken);
    const tokenPriceSol = rec.solIsX ? 1 / pxy : pxy;
    const tokenSol = (raw: string | BN) => (Number(raw.toString()) / 10 ** token.mint.decimals) * tokenPriceSol;
    const lam = (raw: string | BN) => Number(raw.toString()) / 1e9;
    const [solAmt, tokAmt, solFee, tokFee] = rec.solIsX
      ? [pd.totalXAmount, pd.totalYAmount, pd.feeX, pd.feeY]
      : [pd.totalYAmount, pd.totalXAmount, pd.feeY, pd.feeX];
    const feesSol = lam(solFee) + tokenSol(tokFee);
    return { valueSol: lam(solAmt) + tokenSol(tokAmt) + feesSol, feesSol, activeId: active.binId };
  }

  async close(rec: PositionRec, s: Settings): Promise<number> {
    const d = await this.pools.dlmm(rec.pool);
    const key = new PublicKey(rec.position);
    const before = await this.sol.balanceSol();
    const pos = await d.getPosition(key);
    const { lowerBinId, upperBinId } = pos.positionData;
    const hasLiquidity = pos.positionData.positionBinData.some((b) => b.positionLiquidity !== "0");
    const txs = hasLiquidity
      ? await d.removeLiquidity({ user: this.sol.address, position: key, fromBinId: lowerBinId, toBinId: upperBinId, bps: new BN(10_000), shouldClaimAndClose: true })
      : [await d.closePosition({ owner: this.sol.address, position: pos })];
    for (const tx of txs) await this.sol.sendInstructions(tx.instructions, [], s.priorityMicroLamports);
    if (s.swapToSolOnClose) await this.sellToSol(rec.mint, s).catch((e) => log.warn(`sell ${rec.symbol} → SOL failed: ${shortErr(e)}`));
    return (await this.sol.balanceSol()) - before;
  }

  private async sellToSol(mint: string, s: Settings) {
    const amount = await this.sol.tokenBalance(new PublicKey(mint));
    if (amount === 0n) return;
    // widen slippage on retries: a dumping token can move between quote and land
    for (const bps of [100, 300, 800].map((b) => Math.max(b, Math.round(s.slippagePct * 100)))) {
      try {
        const q = await this.jup.quote(mint, WSOL, amount, bps);
        if (!q) throw new Error("no route");
        await this.sol.sendVersioned(await this.jup.swapTx(q, this.sol.address.toBase58()));
        return;
      } catch (e) {
        log.warn(`swap at ${bps} bps failed: ${shortErr(e)}`);
      }
    }
    throw new Error("all swap attempts failed; token left in wallet");
  }
}
