/**
 * Jev (TypeSafe System One) screener. One request per token: two Nouls (copycat, rug signs)
 * and a Score (overall risk), all judged against the same state. Thresholds live in
 * screen.ts / settings, not here. API: https://docs.typesafe.ai/api
 */
import type { TokenFacts } from "./facts";
import type { Candidate } from "./scanner";
import type { Assessment, Screener } from "./screen";
import { logger } from "../log";

const log = logger("jev");
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const RISK_LEVELS = [
  "Low: ownership renounced or harmless, no admin levers, plain token",
  "Moderate: an active owner but few levers, nothing that touches holder balances or transfers",
  "Elevated: owner can change fees or trading limits, or the contract is upgradeable",
  "High: owner can mint, blacklist, pause or set taxes, or name imitates another project",
  "Extreme: several of the above together, typical of a rug or honeypot setup",
];

const QUESTIONS = {
  copycat: {
    type: "noul",
    instructions:
      "Does `token`'s name or symbol imitate a well-known crypto project or brand, or one of `other_listed`, rather than being its own project?",
    criteria: {
      true: "Copies or closely mimics an established name/ticker (e.g. PEPE2, USDC.e lookalike, a misspelling, 'Official', 'v2')",
      false: "Distinct name and symbol of its own",
    },
  },
  rug_signs: {
    type: "noul",
    instructions:
      "Given `token`'s ownership, upgradeability and `admin_functions`, can the deployer still take value from holders (mint, blacklist, freeze trading, raise taxes, swap the implementation)?",
    criteria: {
      true: "An active owner or upgradeable proxy holds levers over balances, transfers or fees",
      false: "No such levers remain (renounced, no admin functions, not upgradeable)",
    },
  },
  risk: {
    type: "score",
    instructions: "How risky is it to provide liquidity for `token` against WETH right now, considering `token` and `market`?",
    criteria: RISK_LEVELS,
  },
} as const;

interface Answer {
  type: string;
  noul?: number;
  score?: number;
}

export interface JevOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** retries on 429 / 529 / network errors */
  retries?: number;
  fetch?: typeof fetch;
}

export class JevScreener implements Screener {
  readonly name = "jev";
  private readonly model: string;
  constructor(private readonly opts: JevOptions) {
    this.model = opts.model || "jev-latest";
  }

  async assess(facts: TokenFacts, market: Candidate, others: string[]): Promise<Assessment> {
    const body = {
      model: this.model,
      state: {
        token: facts,
        market: {
          fee_tier_pct: market.fee / 10_000,
          weth_depth: Number(market.depthWei) / 1e18,
          fee_apr_pct: Math.round(market.aprEmaPct),
          price_move_last_scan_pct: Number(market.movePct.toFixed(2)),
          swaps_last_scan: market.swaps,
        },
        other_listed: others.slice(0, 50),
      },
      questions: QUESTIONS,
    };
    const res = await this.post(body);
    const a = res.answers;
    const num = (v: unknown, what: string) => {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`jev: missing ${what} in answer`);
      return v;
    };
    const copycat = num(a.copycat?.noul, "copycat");
    const rugSigns = num(a.rug_signs?.noul, "rug_signs");
    const risk = num(a.risk?.score, "risk") / (RISK_LEVELS.length - 1);
    log.debug(`${facts.symbol} ${res.model}: copycat ${copycat} rug ${rugSigns} risk ${risk}`);
    return { copycat, rugSigns, risk: Math.min(1, Math.max(0, risk)), source: res.model || this.model };
  }

  private async post(body: unknown): Promise<{ model: string; answers: Record<string, Answer | undefined> }> {
    const f = this.opts.fetch ?? fetch;
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      try {
        const r = await f(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        });
        status = r.status;
        if (r.ok) return (await r.json()) as { model: string; answers: Record<string, Answer | undefined> };
        const text = (await r.text().catch(() => "")).slice(0, 200);
        if (status !== 429 && status !== 529) throw new Error(`jev HTTP ${status}: ${text}`);
        if (attempt >= retries) throw new Error(`jev HTTP ${status} after ${attempt + 1} tries`);
      } catch (e) {
        // HTTP errors other than 429/529 are final; network errors and timeouts are retried
        if (status && status !== 429 && status !== 529) throw e;
        if (attempt >= retries) throw e;
      }
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
    }
  }
}
