/**
 * LP operations. Every operation has a live path (real transactions) and a paper path
 * (same pool reads, same SDK math, same quotes, nothing broadcast), so paper results are
 * what live would have done at that moment, minus gas.
 */
import { ethers } from "ethers";
import { CurrencyAmount, Percent, type Currency } from "@uniswap/sdk-core";
import { NonfungiblePositionManager, Position } from "@uniswap/v3-sdk";
import JSBI from "jsbi";
import type { Chain } from "../chain/client";
import { ERC20_ABI, NPM_ABI, QUOTER_V2_ABI, ROUTER02_ABI, ROUTER_ADDRESS_THIS } from "../chain/abis";
import { findWethPools, readPoolView, sdkPool, type PoolView } from "../chain/pools";
import { erc20Balance, sdkToken } from "../chain/tokens";
import { computeRange, isInRange, tokenShareForRange, type Range, type RangeMode } from "../core/range";
import { computePnl, feesFromGrowth, tokenToQuote, type Pnl } from "../core/pnl";
import type { Settings } from "../config";
import { PositionBook, type ClosedRecord, type PositionRecord } from "./positions";
import { Native } from "./native";
import { logger } from "../log";
import { V4PositionManager, Position as V4Position } from "@uniswap/v4-sdk";
import { encodeV4Swap, quoteV4, rememberV4Key, v4Of, v4PositionFees, V4_POSM_ABI } from "../chain/v4";
import { ensurePermit2, v4Position, v4SdkPool } from "./v4";

const log = logger("lp");
const MAX_U128 = (1n << 128n) - 1n;
const npmIface = new ethers.Interface(NPM_ABI);
const routerIface = new ethers.Interface(ROUTER02_ABI);

export interface OpenPlan {
  pool: PoolView;
  mode: RangeMode;
  range: Range;
  amountWei: bigint;
  /** ETH that will be swapped into the token first (in-range only) */
  swapInWei: bigint;
  swapFee: number;
  swapOut: bigint;
  /** token price (ETH per token) at the range edges */
  priceLower: number;
  priceUpper: number;
}

export interface PositionStatus {
  rec: PositionRecord;
  pool: PoolView;
  /** current position liquidity (on-chain for live positions) */
  liquidity: bigint;
  inRange: boolean;
  amountToken: bigint;
  amountQuote: bigint;
  feeToken: bigint;
  feeQuote: bigint;
  pnl: Pnl;
}

export interface TxSummary {
  label: string;
  hash: string;
}

export class LpService {
  constructor(
    readonly chain: Chain,
    readonly book: PositionBook,
    readonly settings: () => Settings,
    readonly paper: boolean,
  ) {}

  private get c() {
    return this.chain.contracts;
  }
  private slippage(): Percent {
    return new Percent(Math.round(this.settings().slippagePct * 100), 10_000);
  }
  private minOut(amount: bigint): bigint {
    return (amount * BigInt(10_000 - Math.round(this.settings().slippagePct * 100))) / 10_000n;
  }
  private deadline(): number {
    return Math.floor(Date.now() / 1000) + 600;
  }
  private native(pool: PoolView): Native {
    return new Native(sdkToken(this.chain.cfg.chain.chainId, pool.quote));
  }

  findPools(token: string): Promise<PoolView[]> {
    return findWethPools(this.chain, ethers.getAddress(token), this.settings().feeTiers);
  }

  /** Best quote across fee tiers. Returns fee 0 / out 0 when no route exists. */
  async quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ fee: number; out: bigint }> {
    const q = new ethers.Contract(this.c.quoterV2, QUOTER_V2_ABI, this.chain.provider);
    let best = { fee: 0, out: 0n };
    for (const fee of this.settings().feeTiers) {
      try {
        const r = await q.getFunction("quoteExactInputSingle").staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n });
        const out = BigInt(r[0]);
        if (out > best.out) best = { fee, out };
      } catch {
        /* no pool on this tier */
      }
    }
    return best;
  }

  /** Quote ETH ↔ the pool's token where this pool's positions trade: v3 best tier, or the v4 pool itself. */
  async quoteFor(pool: PoolView, ethToToken: boolean, amountIn: bigint): Promise<{ fee: number; out: bigint }> {
    if (pool.version === 4) return { fee: pool.fee, out: await quoteV4(this.chain, pool.v4Key!, ethToToken, amountIn) };
    return ethToToken ? this.quote(this.c.weth, pool.token.address, amountIn) : this.quote(pool.token.address, this.c.weth, amountIn);
  }

  rangeFor(pool: PoolView, mode: RangeMode, widthPct = this.settings().widthPct): Range {
    return computeRange(mode, {
      tick: pool.tick,
      tickSpacing: pool.tickSpacing,
      quoteIsToken0: pool.quoteIsToken0,
      widthPct,
      singleOffsetPct: this.settings().singleOffsetPct,
    });
  }

  priceAtTick(pool: PoolView, tick: number): number {
    const dec0 = pool.quoteIsToken0 ? pool.quote.decimals : pool.token.decimals;
    const dec1 = pool.quoteIsToken0 ? pool.token.decimals : pool.quote.decimals;
    const p = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
    return pool.quoteIsToken0 ? 1 / p : p;
  }

  async plan(poolAddr: string, amountWei: bigint, mode: RangeMode): Promise<OpenPlan> {
    const pool = await readPoolView(this.chain, poolAddr);
    const range = this.rangeFor(pool, mode);
    let swapInWei = 0n;
    let swap = { fee: 0, out: 0n };
    if (mode === "inrange") {
      const share = tokenShareForRange(pool.tick, range, pool.quoteIsToken0);
      swapInWei = (amountWei * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
      if (swapInWei > 0n) {
        swap = await this.quoteFor(pool, true, swapInWei);
        if (swap.out === 0n) throw new Error(`no swap route ETH → ${pool.token.symbol}`);
      }
    }
    const a = this.priceAtTick(pool, range.tickLower);
    const b = this.priceAtTick(pool, range.tickUpper);
    return { pool, mode, range, amountWei, swapInWei, swapFee: swap.fee, swapOut: swap.out, priceLower: Math.min(a, b), priceUpper: Math.max(a, b) };
  }

  /** Execute a plan. Re-reads the pool so the range is centred on the price at send time. */
  async open(plan: OpenPlan, widthPct = this.settings().widthPct): Promise<{ rec: PositionRecord; txs: TxSummary[] }> {
    const { mode, amountWei } = plan;
    if (amountWei <= 0n) throw new Error("amount must be > 0");
    if (!this.paper) {
      const bal = await this.chain.nativeBalance();
      const reserve = ethers.parseEther(String(this.settings().gasReserveEth));
      if (bal < amountWei + reserve) {
        throw new Error(`insufficient ETH: have ${ethers.formatEther(bal)}, need ${ethers.formatEther(amountWei)} + ${ethers.formatEther(reserve)} gas reserve`);
      }
    }
    const run = async () => {
      const txs: TxSummary[] = [];
      const token = plan.pool.token;
      let swapIn = 0n;
      let tokenGot = 0n;
      if (mode === "inrange" && plan.swapInWei > 0n) {
        swapIn = plan.swapInWei;
        const q = await this.quoteFor(plan.pool, true, swapIn);
        if (q.out === 0n) throw new Error(`no swap route ETH → ${token.symbol}`);
        if (this.paper) {
          tokenGot = q.out;
        } else if (plan.pool.version === 4) {
          const before = await erc20Balance(this.chain, token.address, this.chain.address);
          const data = encodeV4Swap(plan.pool.v4Key!, true, swapIn, this.minOut(q.out), this.deadline());
          const rc = await this.chain.send(`swap ETH→${token.symbol} (v4)`, { to: v4Of(this.chain).universalRouter, data, value: swapIn });
          txs.push({ label: "swap", hash: rc.hash });
          tokenGot = (await erc20Balance(this.chain, token.address, this.chain.address)) - before;
          await ensurePermit2(this.chain, token.address, v4Of(this.chain).positionManager, tokenGot, txs);
        } else {
          const before = await erc20Balance(this.chain, token.address, this.chain.address);
          const data = routerIface.encodeFunctionData("exactInputSingle", [
            { tokenIn: this.c.weth, tokenOut: token.address, fee: q.fee, recipient: this.chain.address, amountIn: swapIn, amountOutMinimum: this.minOut(q.out), sqrtPriceLimitX96: 0n },
          ]);
          const rc = await this.chain.send(`swap ETH→${token.symbol}`, { to: this.c.swapRouter02, data, value: swapIn });
          txs.push({ label: "swap", hash: rc.hash });
          tokenGot = (await erc20Balance(this.chain, token.address, this.chain.address)) - before;
          await this.ensureAllowance(token.address, this.c.positionManager, tokenGot, txs);
        }
      }
      const quoteForPosition = amountWei - swapIn;
      const pool = await readPoolView(this.chain, plan.pool.address);
      const range = this.rangeFor(pool, mode, widthPct);
      const amt0 = pool.quoteIsToken0 ? quoteForPosition : tokenGot;
      const amt1 = pool.quoteIsToken0 ? tokenGot : quoteForPosition;
      const v4 = pool.version === 4 ? v4SdkPool(this.chain, pool) : null;
      const fromAmounts = { tickLower: range.tickLower, tickUpper: range.tickUpper, amount0: amt0.toString(), amount1: amt1.toString(), useFullPrecision: true };
      const position: Position | V4Position = v4
        ? V4Position.fromAmounts({ pool: v4.pool, ...fromAmounts })
        : Position.fromAmounts({ pool: sdkPool(this.chain.cfg.chain.chainId, pool), ...fromAmounts });
      if (JSBI.equal(position.liquidity, JSBI.BigInt(0))) throw new Error("amount too small for this range (liquidity 0)");

      let id: string;
      let liquidity: bigint;
      let used0: bigint;
      let used1: bigint;
      if (this.paper) {
        id = this.book.nextPaperId();
        liquidity = BigInt(position.liquidity.toString());
        const m = position.mintAmounts;
        used0 = BigInt(m.amount0.toString());
        used1 = BigInt(m.amount1.toString());
      } else if (v4) {
        const posm = v4Of(this.chain).positionManager;
        const [ethBefore, tokBefore] = [await this.chain.nativeBalance(), await erc20Balance(this.chain, token.address, this.chain.address)];
        const { calldata, value } = V4PositionManager.addCallParameters(position as V4Position, {
          slippageTolerance: this.slippage(),
          recipient: this.chain.address,
          deadline: this.deadline(),
          useNative: v4.native,
        });
        const rc = await this.chain.send(`mint ${token.symbol} (v4)`, { to: posm, data: calldata, value: BigInt(value) });
        txs.push({ label: "mint", hash: rc.hash });
        const iface = new ethers.Interface(V4_POSM_ABI);
        const ev = rc.logs
          .filter((l) => l.address.toLowerCase() === posm.toLowerCase())
          .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
          .find((p) => p?.name === "Transfer" && p.args[0] === ethers.ZeroAddress);
        if (!ev) throw new Error(`mint sent (${rc.hash}) but no position NFT was minted`);
        id = BigInt(ev.args[2]).toString();
        liquidity = BigInt(await new ethers.Contract(posm, V4_POSM_ABI, this.chain.provider).getFunction("getPositionLiquidity")(id));
        // what actually left the wallet (the mint sweeps unused ETH back)
        used0 = ethBefore - (await this.chain.nativeBalance()) - rc.gasUsed * (rc.gasPrice ?? 0n);
        used1 = tokBefore - (await erc20Balance(this.chain, token.address, this.chain.address));
      } else {
        const { calldata, value } = NonfungiblePositionManager.addCallParameters(position as Position, {
          slippageTolerance: this.slippage(),
          recipient: this.chain.address,
          deadline: this.deadline(),
          useNative: this.native(pool),
        });
        const rc = await this.chain.send(`mint ${token.symbol}`, { to: this.c.positionManager, data: calldata, value: BigInt(value) });
        txs.push({ label: "mint", hash: rc.hash });
        const ev = rc.logs
          .filter((l) => l.address.toLowerCase() === this.c.positionManager.toLowerCase())
          .map((l) => { try { return npmIface.parseLog(l); } catch { return null; } })
          .find((p) => p?.name === "IncreaseLiquidity");
        if (!ev) throw new Error(`mint sent (${rc.hash}) but no IncreaseLiquidity event found`);
        id = BigInt(ev.args[0]).toString();
        liquidity = BigInt(ev.args[1]);
        used0 = BigInt(ev.args[2]);
        used1 = BigInt(ev.args[3]);
      }
      const usedQuote = pool.quoteIsToken0 ? used0 : used1;
      const usedToken = pool.quoteIsToken0 ? used1 : used0;
      const rec: PositionRecord = {
        id,
        kind: this.paper ? "paper" : "live",
        ...(pool.version === 4 ? { version: 4 as const, v4Key: pool.v4Key } : {}),
        pool: pool.address,
        token: token.address,
        symbol: token.symbol,
        tokenDecimals: token.decimals,
        quoteIsToken0: pool.quoteIsToken0,
        fee: pool.fee,
        tickSpacing: pool.tickSpacing,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        mode,
        widthPct,
        liquidity: liquidity.toString(),
        depositQuote: (usedQuote + swapIn).toString(),
        depositToken: usedToken.toString(),
        depositQuoteInPosition: usedQuote.toString(),
        leftoverToken: (tokenGot > usedToken ? tokenGot - usedToken : 0n).toString(),
        collectedQuote: "0",
        openedAt: Date.now(),
        inRange: isInRange(pool.tick, range),
        ...(this.paper
          ? { paperFee0: "0", paperFee1: "0", growth0: pool.feeGrowthGlobal0X128.toString(), growth1: pool.feeGrowthGlobal1X128.toString() }
          : {}),
      };
      this.book.put(rec);
      log.info(`open ${rec.kind} #${id} ${token.symbol} ${mode} deposit=${ethers.formatEther(rec.depositQuote)}`);
      return { rec, txs };
    };
    return this.paper ? run() : this.chain.exclusive(run);
  }

  private async ensureAllowance(token: string, spender: string, amount: bigint, txs: TxSummary[]) {
    const c = new ethers.Contract(token, ERC20_ABI, this.chain.provider);
    const cur: bigint = await c.getFunction("allowance")(this.chain.address, spender);
    if (cur >= amount) return;
    // exact-amount approvals: the bot never leaves an unlimited allowance behind
    const data = c.interface.encodeFunctionData("approve", [spender, amount]);
    const rc = await this.chain.send("approve", { to: token, data });
    txs.push({ label: "approve", hash: rc.hash });
  }

  /** Paper only: credit fee growth since the last snapshot while the position is in range. */
  private accruePaper(rec: PositionRecord, pool: PoolView) {
    if (rec.kind !== "paper") return;
    const L = BigInt(rec.liquidity);
    const nowIn = isInRange(pool.tick, rec);
    // credit only when in range at both readings; the monitor polls often enough that misses are small
    if (nowIn && rec.paperInRange !== false) {
      rec.paperFee0 = (BigInt(rec.paperFee0 ?? "0") + feesFromGrowth(L, BigInt(rec.growth0 ?? "0"), pool.feeGrowthGlobal0X128)).toString();
      rec.paperFee1 = (BigInt(rec.paperFee1 ?? "0") + feesFromGrowth(L, BigInt(rec.growth1 ?? "0"), pool.feeGrowthGlobal1X128)).toString();
    }
    rec.growth0 = pool.feeGrowthGlobal0X128.toString();
    rec.growth1 = pool.feeGrowthGlobal1X128.toString();
    rec.paperInRange = nowIn;
  }

  async status(rec: PositionRecord): Promise<PositionStatus> {
    if (rec.v4Key) rememberV4Key(rec.v4Key);
    const pool = await readPoolView(this.chain, rec.pool);
    let liquidity = BigInt(rec.liquidity);
    let fee0: bigint;
    let fee1: bigint;
    if (rec.kind === "live" && pool.version === 4) {
      const f = await v4PositionFees(this.chain, pool.address, rec.id, rec.tickLower, rec.tickUpper);
      liquidity = f.liquidity;
      fee0 = f.fee0;
      fee1 = f.fee1;
    } else if (rec.kind === "live") {
      const npm = new ethers.Contract(this.c.positionManager, NPM_ABI, this.chain.provider);
      const p = await npm.getFunction("positions")(rec.id);
      liquidity = BigInt(p.liquidity);
      const owed = await npm.getFunction("collect").staticCall(
        { tokenId: rec.id, recipient: this.chain.address, amount0Max: MAX_U128, amount1Max: MAX_U128 },
        { from: this.chain.address },
      );
      fee0 = BigInt(owed[0]);
      fee1 = BigInt(owed[1]);
    } else {
      this.accruePaper(rec, pool);
      fee0 = BigInt(rec.paperFee0 ?? "0");
      fee1 = BigInt(rec.paperFee1 ?? "0");
    }
    const pos =
      pool.version === 4
        ? v4Position(v4SdkPool(this.chain, pool).pool, liquidity, rec.tickLower, rec.tickUpper)
        : new Position({ pool: sdkPool(this.chain.cfg.chain.chainId, pool), liquidity: liquidity.toString(), tickLower: rec.tickLower, tickUpper: rec.tickUpper });
    const a0 = BigInt(pos.amount0.quotient.toString());
    const a1 = BigInt(pos.amount1.quotient.toString());
    const amountQuote = pool.quoteIsToken0 ? a0 : a1;
    const amountToken = pool.quoteIsToken0 ? a1 : a0;
    const feeQuote = pool.quoteIsToken0 ? fee0 : fee1;
    const feeToken = pool.quoteIsToken0 ? fee1 : fee0;
    const leftover = BigInt(rec.leftoverToken ?? "0");
    const pnl = computePnl({
      depositQuote: BigInt(rec.depositQuote),
      depositToken: BigInt(rec.depositToken) + leftover,
      depositQuoteInPosition: BigInt(rec.depositQuoteInPosition),
      nowToken: amountToken + leftover,
      nowQuote: amountQuote,
      feeToken,
      feeQuote: feeQuote + BigInt(rec.collectedQuote),
      priceQuotePerTokenE18: pool.priceE18,
      tokenDecimals: pool.token.decimals,
    });
    return { rec, pool, liquidity, inRange: isInRange(pool.tick, rec), amountToken, amountQuote, feeToken, feeQuote, pnl };
  }

  /** Claim fees without touching the position. Returns the fees valued in ETH. */
  async collect(id: string): Promise<{ feesQuote: bigint; txs: TxSummary[] }> {
    const rec = this.mustGet(id);
    const run = async () => {
      const st = await this.status(rec);
      const feesQuote = st.feeQuote + tokenToQuote(st.feeToken, st.pool.priceE18, st.pool.token.decimals);
      const txs: TxSummary[] = [];
      if (rec.kind === "live" && st.pool.version === 4) {
        const { pool } = v4SdkPool(this.chain, st.pool);
        const { calldata, value } = V4PositionManager.collectCallParameters(v4Position(pool, st.liquidity, rec.tickLower, rec.tickUpper), {
          tokenId: rec.id,
          recipient: this.chain.address,
          slippageTolerance: this.slippage(),
          deadline: this.deadline(),
        });
        const rc = await this.chain.send(`collect #${rec.id} (v4)`, { to: v4Of(this.chain).positionManager, data: calldata, value: BigInt(value) });
        txs.push({ label: "collect", hash: rc.hash });
      } else if (rec.kind === "live") {
        const { calldata, value } = NonfungiblePositionManager.collectCallParameters({
          tokenId: rec.id,
          ...this.expectedOwed(st),
          recipient: this.chain.address,
        });
        const rc = await this.chain.send(`collect #${rec.id}`, { to: this.c.positionManager, data: calldata, value: BigInt(value) });
        txs.push({ label: "collect", hash: rc.hash });
      } else {
        rec.paperFee0 = "0";
        rec.paperFee1 = "0";
      }
      // ETH-side fees are realized; token-side fees stay with the position until close sweeps them
      rec.collectedQuote = (BigInt(rec.collectedQuote) + st.feeQuote).toString();
      rec.leftoverToken = (BigInt(rec.leftoverToken ?? "0") + st.feeToken).toString();
      this.book.put(rec);
      return { feesQuote, txs };
    };
    return rec.kind === "live" ? this.chain.exclusive(run) : run();
  }

  private expectedOwed(st: PositionStatus): { expectedCurrencyOwed0: CurrencyAmount<Currency>; expectedCurrencyOwed1: CurrencyAmount<Currency> } {
    const native = this.native(st.pool);
    const tok = sdkToken(this.chain.cfg.chain.chainId, st.pool.token);
    const q = CurrencyAmount.fromRawAmount(native, st.feeQuote.toString());
    const t = CurrencyAmount.fromRawAmount(tok, st.feeToken.toString());
    return st.pool.quoteIsToken0
      ? { expectedCurrencyOwed0: q, expectedCurrencyOwed1: t }
      : { expectedCurrencyOwed0: t, expectedCurrencyOwed1: q };
  }

  /** Remove all liquidity, collect fees, burn the NFT and (optionally) swap the token side back to ETH. */
  async close(id: string, reason = "manual", swapToEth = this.settings().swapToEthOnClose): Promise<{ closed: ClosedRecord; txs: TxSummary[]; realizedQuote: bigint }> {
    const rec = this.mustGet(id);
    const run = async () => {
      const st = await this.status(rec);
      const txs: TxSummary[] = [];
      const leftover = BigInt(rec.leftoverToken ?? "0");
      const tokenTotal = st.amountToken + st.feeToken + leftover;
      let quoteTotal = st.amountQuote + st.feeQuote;
      let tokenValue = tokenToQuote(tokenTotal, st.pool.priceE18, st.pool.token.decimals);

      if (rec.kind === "live") {
        const before = await erc20Balance(this.chain, rec.token, this.chain.address);
        if (st.pool.version === 4) {
          const { pool } = v4SdkPool(this.chain, st.pool);
          const { calldata, value } = V4PositionManager.removeCallParameters(v4Position(pool, st.liquidity, rec.tickLower, rec.tickUpper), {
            tokenId: rec.id,
            liquidityPercentage: new Percent(1),
            slippageTolerance: this.slippage(),
            deadline: this.deadline(),
            burnToken: true,
          });
          const rc = await this.chain.send(`close #${rec.id} (v4)`, { to: v4Of(this.chain).positionManager, data: calldata, value: BigInt(value) });
          txs.push({ label: "close", hash: rc.hash });
        } else {
        const sdk = sdkPool(this.chain.cfg.chain.chainId, st.pool);
        const npm = new ethers.Contract(this.c.positionManager, NPM_ABI, this.chain.provider);
        const onchain = await npm.getFunction("positions")(rec.id);
        const live = new Position({ pool: sdk, liquidity: BigInt(onchain.liquidity).toString(), tickLower: rec.tickLower, tickUpper: rec.tickUpper });
        const { calldata, value } = NonfungiblePositionManager.removeCallParameters(live, {
          tokenId: rec.id,
          liquidityPercentage: new Percent(1),
          slippageTolerance: this.slippage(),
          deadline: this.deadline(),
          burnToken: true,
          collectOptions: { ...this.expectedOwed(st), recipient: this.chain.address },
        });
        const rc = await this.chain.send(`close #${rec.id}`, { to: this.c.positionManager, data: calldata, value: BigInt(value) });
        txs.push({ label: "close", hash: rc.hash });
        }
        const bal = await erc20Balance(this.chain, rec.token, this.chain.address);
        // what the close returned + this position's leftover, never other tokens the wallet holds
        const got = bal - before + (leftover < before ? leftover : before);
        if (swapToEth && got > 0n) {
          const out = await this.swapTokenToEth(rec.token, got, txs, st.pool);
          quoteTotal += out;
          tokenValue = 0n;
        }
      } else if (swapToEth && tokenTotal > 0n) {
        const q = await this.quoteFor(st.pool, false, tokenTotal);
        quoteTotal += q.out;
        tokenValue = 0n;
      }

      const realizedQuote = quoteTotal + tokenValue + BigInt(rec.collectedQuote);
      const deposit = BigInt(rec.depositQuote);
      const pnlQuote = realizedQuote - deposit;
      const closed: ClosedRecord = {
        id: rec.id,
        kind: rec.kind,
        symbol: rec.symbol,
        fee: rec.fee,
        mode: rec.mode,
        openedAt: rec.openedAt,
        closedAt: Date.now(),
        depositQuote: rec.depositQuote,
        realizedQuote: realizedQuote.toString(),
        feesQuote: st.pnl.feesQuote.toString(),
        pnlQuote: pnlQuote.toString(),
        pnlPct: deposit > 0n ? Number((pnlQuote * 1_000_000n) / deposit) / 10_000 : 0,
        reason,
      };
      this.book.close(rec.id, closed);
      log.info(`close ${rec.kind} #${rec.id} ${rec.symbol} (${reason}) pnl=${ethers.formatEther(pnlQuote)} ETH`);
      return { closed, txs, realizedQuote };
    };
    return rec.kind === "live" ? this.chain.exclusive(run) : run();
  }

  /** Must be called inside exclusive(). */
  private async swapTokenToEth(token: string, amount: bigint, txs: TxSummary[], pool?: PoolView): Promise<bigint> {
    const q = pool ? await this.quoteFor(pool, false, amount) : await this.quote(token, this.c.weth, amount);
    if (q.out === 0n) {
      log.warn(`no route ${token} → ETH; keeping the token`);
      return 0n;
    }
    if (pool?.version === 4) {
      // sell back into the same v4 pool; ETH arrives natively (no WETH to unwrap)
      const ur = v4Of(this.chain).universalRouter;
      await ensurePermit2(this.chain, token, ur, amount, txs);
      const before = await this.chain.nativeBalance();
      const rc = await this.chain.send("swap token→ETH (v4)", { to: ur, data: encodeV4Swap(pool.v4Key!, false, amount, this.minOut(q.out), this.deadline()) });
      txs.push({ label: "swap", hash: rc.hash });
      return (await this.chain.nativeBalance()) - before + rc.gasUsed * (rc.gasPrice ?? 0n);
    }
    await this.ensureAllowance(token, this.c.swapRouter02, amount, txs);
    const minOut = this.minOut(q.out);
    const before = await this.chain.nativeBalance();
    const data = routerIface.encodeFunctionData("multicall(bytes[])", [
      [
        routerIface.encodeFunctionData("exactInputSingle", [
          { tokenIn: token, tokenOut: this.c.weth, fee: q.fee, recipient: ROUTER_ADDRESS_THIS, amountIn: amount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n },
        ]),
        routerIface.encodeFunctionData("unwrapWETH9", [minOut, this.chain.address]),
      ],
    ]);
    const rc = await this.chain.send("swap token→ETH", { to: this.c.swapRouter02, data });
    txs.push({ label: "swap", hash: rc.hash });
    const gas = rc.gasUsed * (rc.gasPrice ?? 0n);
    return (await this.chain.nativeBalance()) - before + gas;
  }

  /** Close (swapping to ETH) and reopen the same mode/width around the current price. */
  async rebalance(id: string, reason = "rebalance"): Promise<{ closed: ClosedRecord; rec: PositionRecord; txs: TxSummary[] }> {
    const old = this.mustGet(id);
    const { closed, txs, realizedQuote } = await this.close(id, reason, true);
    let amount = realizedQuote;
    if (old.kind === "live") {
      const bal = await this.chain.nativeBalance();
      const reserve = ethers.parseEther(String(this.settings().gasReserveEth));
      const spendable = bal > reserve ? bal - reserve : 0n;
      if (amount > spendable) amount = spendable;
    }
    const plan = await this.plan(old.pool, amount, old.mode);
    const { rec, txs: openTxs } = await this.open(plan, old.widthPct);
    return { closed, rec, txs: [...txs, ...openTxs] };
  }

  private mustGet(id: string): PositionRecord {
    const rec = this.book.get(id);
    if (!rec) throw new Error(`no open position "${id}"`);
    return rec;
  }
}
