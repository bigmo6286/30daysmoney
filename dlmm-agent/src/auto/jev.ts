/**
 * Token screening with Jev (TypeSafe System One, https://docs.typesafe.ai/api).
 * One request per token: two Nouls (copycat name; deployer can still take value) and a
 * 5-level risk Score. Jev judges; the thresholds that block an open live in settings.
 */
import type { MintFacts } from "../chain/facts";
import type { Pool } from "./discovery";
import { logger } from "../log";

const log = logger("jev");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export interface Assessment {
  copycat: number;
  rugSigns: number;
  /** 0 (low) … 1 (extreme) */
  risk: number;
  source: string;
}

export interface Screener {
  readonly name: string;
  assess(facts: MintFacts, pool: Pool, others: string[]): Promise<Assessment>;
  peek?(mint: string): Assessment | undefined;
}

export interface Thresholds {
  maxCopycatPct: number;
  maxRugPct: number;
  maxRiskPct: number;
}

export function verdict(a: Assessment, t: Thresholds): { ok: boolean; reason?: string } {
  const p = (x: number) => `${(x * 100).toFixed(0)}%`;
  if (a.copycat * 100 > t.maxCopycatPct) return { ok: false, reason: `copycat ${p(a.copycat)}` };
  if (a.rugSigns * 100 > t.maxRugPct) return { ok: false, reason: `rug signs ${p(a.rugSigns)}` };
  if (a.risk * 100 > t.maxRiskPct) return { ok: false, reason: `risk ${p(a.risk)}` };
  return { ok: true };
}

const RISK_LEVELS = [
  "Low: authorities revoked, no risky extensions, broad holder base, established pool",
  "Moderate: clean contract, some holder concentration or a young token",
  "Elevated: concentrated holders, very young, or thin liquidity relative to market cap",
  "High: live mint authority, heavy concentration, or a name that imitates another project",
  "Extreme: several of the above together, typical of a rug or pump-and-dump",
];

const QUESTIONS = {
  copycat: {
    type: "noul",
    instructions: "Does `token`'s name or symbol imitate a well-known crypto project or brand, or one of `other_listed`, rather than being its own project?",
    criteria: {
      true: "Copies or closely mimics an established name/ticker (a misspelling, 'Official', '2.0', a famous ticker on a new mint)",
      false: "Distinct name and symbol of its own",
    },
  },
  rug_signs: {
    type: "noul",
    instructions:
      "Given `token`'s authorities, extensions and holder concentration, can the deployer or a few wallets still take value from holders (print supply, freeze, move tokens, dump a concentrated bag)?",
    criteria: {
      true: "Live authorities, risky extensions, or a few wallets hold enough to crash the price",
      false: "Authorities revoked, no risky extensions, supply widely held",
    },
  },
  risk: {
    type: "score",
    instructions: "How risky is it to provide single-sided SOL liquidity for `token` right now, considering `token` and `market`?",
    criteria: RISK_LEVELS,
  },
} as const;

export class JevScreener implements Screener {
  readonly name = "jev";
  constructor(
    private readonly apiKey: string,
    private readonly model = "jev-latest",
    private readonly f: typeof fetch = fetch,
  ) {}

  async assess(facts: MintFacts, pool: Pool, others: string[]): Promise<Assessment> {
    const ageH = pool.createdAt ? Math.round((Date.now() - pool.createdAt) / 3_600_000) : null;
    const body = {
      model: this.model,
      state: {
        token: {
          name: pool.name,
          symbol: pool.symbol,
          mint: facts.mint,
          program: facts.program,
          mint_authority: facts.mintAuthority ?? "revoked",
          freeze_authority: facts.freezeAuthority ?? "revoked",
          extensions: facts.extensions,
          transfer_fee_pct: facts.transferFeeBps / 100,
          top10_holders_pct: facts.top10Pct,
          supply_in_pool_pct: facts.inPoolPct,
          holders: pool.holders,
          age_hours: ageH,
          launchpad: pool.launchpad ?? null,
        },
        market: {
          market_cap_usd: Math.round(pool.mcapUsd),
          tvl_usd: Math.round(pool.tvlUsd),
          volume_usd: Math.round(pool.volumeUsd),
          fee_tvl_pct: pool.feeTvlPct,
          volatility: pool.volatility,
          organic_score: pool.organic,
          bin_step: pool.binStep,
        },
        other_listed: others.slice(0, 50),
      },
      questions: QUESTIONS,
    };
    const res = await this.post(body);
    const a = res.answers ?? {};
    const num = (v: unknown, what: string) => {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`jev: missing ${what} in answer`);
      return v;
    };
    const risk = num(a.risk?.score, "risk") / (RISK_LEVELS.length - 1);
    const out = {
      copycat: num(a.copycat?.noul, "copycat"),
      rugSigns: num(a.rug_signs?.noul, "rug_signs"),
      risk: Math.min(1, Math.max(0, risk)),
      source: res.model || this.model,
    };
    log.debug(`${pool.symbol}: ${JSON.stringify(out)}`);
    return out;
  }

  private async post(body: unknown): Promise<{ model?: string; answers?: Record<string, { noul?: number; score?: number } | undefined> }> {
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const r = await this.f(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        status = r.status;
        if (r.ok) return (await r.json()) as any;
        const text = (await r.text().catch(() => "")).slice(0, 200);
        throw new Error(`jev HTTP ${status}: ${text}`);
      } catch (e) {
        // 429 / 529 / network errors are retried twice; other HTTP errors are final
        if ((status && status !== 429 && status !== 529) || attempt >= 2) throw e;
      }
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
    }
  }
}

/** Judge each mint at most once per `ttlMs`. */
export class CachedScreener implements Screener {
  private cache = new Map<string, { at: number; a: Assessment }>();
  constructor(
    private readonly inner: Screener,
    private readonly ttlMs = 24 * 3_600_000,
  ) {}
  get name() {
    return this.inner.name;
  }
  peek(mint: string): Assessment | undefined {
    const hit = this.cache.get(mint);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.a : undefined;
  }
  async assess(facts: MintFacts, pool: Pool, others: string[]): Promise<Assessment> {
    const hit = this.peek(facts.mint);
    if (hit) return hit;
    const a = await this.inner.assess(facts, pool, others);
    this.cache.set(facts.mint, { at: Date.now(), a });
    return a;
  }
}
