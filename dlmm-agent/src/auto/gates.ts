/**
 * Per-token checks before any open, cheapest first:
 *   1. on-chain mint facts: red flags, live mint authority, holder concentration
 *   2. Jupiter round trip: can the token be sold back, and at what loss
 *   3. Jev (optional): copycat / rug signs / overall risk
 */
import type { Connection } from "@solana/web3.js";
import type { Settings } from "../config";
import { mintFacts, type MintFacts } from "../chain/facts";
import type { Jupiter } from "../chain/jupiter";
import { shortErr } from "../chain/solana";
import type { Pool } from "./discovery";
import { verdict, type Assessment, type Screener } from "./jev";

export interface GateResult {
  ok: boolean;
  reason?: string;
  /** couldn't decide (RPC / API down): not the token's fault, so no cooldown */
  error?: boolean;
  facts?: MintFacts;
  assessment?: Assessment;
  roundTripLossPct?: number;
}

export interface Gates {
  readonly screener?: Screener;
  check(pool: Pool, sizeSol: number, s: Settings, others: string[], opts?: { skipScreen?: boolean }): Promise<GateResult>;
}

export class TokenGates implements Gates {
  constructor(
    private readonly conn: Connection,
    private readonly jup: Jupiter,
    readonly screener?: Screener,
  ) {}

  async check(pool: Pool, sizeSol: number, s: Settings, others: string[], opts: { skipScreen?: boolean } = {}): Promise<GateResult> {
    let facts: MintFacts;
    try {
      facts = await mintFacts(this.conn, pool.mint, pool.address);
    } catch (e) {
      return { ok: false, error: true, reason: `mint read failed: ${shortErr(e)}` };
    }
    if (facts.redFlags.length) return { ok: false, reason: facts.redFlags[0], facts };
    if (s.requireMintRenounced && facts.mintAuthority) return { ok: false, reason: "mint authority still live", facts };
    if (facts.top10Pct > s.maxTop10Pct) return { ok: false, reason: `top 10 holders own ${facts.top10Pct.toFixed(0)}%`, facts };

    let loss: number | null;
    try {
      loss = await this.jup.roundTripLossPct(pool.mint, BigInt(Math.floor(sizeSol * 1e9)), Math.round(s.slippagePct * 100));
    } catch (e) {
      return { ok: false, error: true, reason: `Jupiter quote failed: ${shortErr(e)}`, facts };
    }
    if (loss === null) return { ok: false, reason: "cannot sell back (no route)", facts };
    if (loss > s.maxRoundTripLossPct) return { ok: false, reason: `round trip loses ${loss.toFixed(1)}%`, facts, roundTripLossPct: loss };

    if (!s.screen || opts.skipScreen) return { ok: true, facts, roundTripLossPct: loss };
    if (!this.screener) return { ok: false, error: true, reason: "screening on but no TYPESAFE_API_KEY", facts, roundTripLossPct: loss };
    let assessment: Assessment;
    try {
      assessment = await this.screener.assess(facts, pool, others);
    } catch (e) {
      return { ok: false, error: true, reason: `screen failed: ${shortErr(e)}`, facts, roundTripLossPct: loss };
    }
    return { ...verdict(assessment, s), facts, assessment, roundTripLossPct: loss };
  }
}
