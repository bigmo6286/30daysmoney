/**
 * Token screening before the autopilot commits funds. The screener judges TokenFacts plus
 * market context; policy (what blocks an open) stays here in code so thresholds can change
 * without re-asking the model.
 */
import type { TokenFacts } from "./facts";
import type { Candidate } from "./scanner";

export interface Assessment {
  /** probability the name/symbol imitates a well-known or other listed project */
  copycat: number;
  /** probability the contract setup lets the deployer take value from holders */
  rugSigns: number;
  /** 0 (low) … 1 (extreme) overall risk */
  risk: number;
  source: string;
}

export interface Screener {
  readonly name: string;
  assess(facts: TokenFacts, market: Candidate, others: string[]): Promise<Assessment>;
  /** a still-valid earlier assessment, if the screener keeps one */
  peek?(token: string): Assessment | undefined;
}

export interface ScreenPolicy {
  maxCopycat: number;
  maxRugSigns: number;
  maxRisk: number;
}

export function screenVerdict(a: Assessment, p: ScreenPolicy): { ok: boolean; reason?: string } {
  if (a.copycat > p.maxCopycat) return { ok: false, reason: `copycat ${(a.copycat * 100).toFixed(0)}%` };
  if (a.rugSigns > p.maxRugSigns) return { ok: false, reason: `rug signs ${(a.rugSigns * 100).toFixed(0)}%` };
  if (a.risk > p.maxRisk) return { ok: false, reason: `risk ${(a.risk * 100).toFixed(0)}%` };
  return { ok: true };
}

/** Cache assessments per token so each one is judged at most once per `ttlMs`. */
export class CachedScreener implements Screener {
  private cache = new Map<string, { at: number; a: Assessment }>();
  constructor(
    private readonly inner: Screener,
    private readonly ttlMs = 24 * 3_600_000,
  ) {}
  get name() {
    return this.inner.name;
  }
  peek(token: string): Assessment | undefined {
    const hit = this.cache.get(token.toLowerCase());
    return hit && Date.now() - hit.at < this.ttlMs ? hit.a : undefined;
  }
  async assess(facts: TokenFacts, market: Candidate, others: string[]): Promise<Assessment> {
    const hit = this.peek(facts.address);
    if (hit) return hit;
    const a = await this.inner.assess(facts, market, others);
    this.cache.set(facts.address.toLowerCase(), { at: Date.now(), a });
    return a;
  }
}
