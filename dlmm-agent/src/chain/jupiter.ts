/**
 * Jupiter swap API v1: quotes for the sell-back check and token → SOL swaps after a close.
 * Uses the keyless lite endpoint unless JUPITER_API_KEY is set.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { WSOL } from "../auto/discovery";

export interface Quote {
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  raw: unknown;
}

export class Jupiter {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(apiKey = "", private readonly f: typeof fetch = fetch) {
    this.base = apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
    this.headers = apiKey ? { "x-api-key": apiKey } : {};
  }

  /** null when there is no route */
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<Quote | null> {
    const url = `${this.base}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const r = await this.f(url, { headers: this.headers, signal: AbortSignal.timeout(15_000) });
    if (r.status === 400 || r.status === 404) return null;
    if (!r.ok) throw new Error(`jupiter quote HTTP ${r.status}`);
    const q = (await r.json()) as { inAmount?: string; outAmount?: string; priceImpactPct?: string; error?: string };
    if (q.error || !q.outAmount) return null;
    return { inAmount: BigInt(q.inAmount ?? amount), outAmount: BigInt(q.outAmount), priceImpactPct: Number(q.priceImpactPct ?? 0) * 100, raw: q };
  }

  /** Buy with `lamports` SOL, then sell everything back: % lost to fees, impact and any sell tax. */
  async roundTripLossPct(mint: string, lamports: bigint, slippageBps: number): Promise<number | null> {
    const buy = await this.quote(WSOL, mint, lamports, slippageBps);
    if (!buy || buy.outAmount === 0n) return null;
    const sell = await this.quote(mint, WSOL, buy.outAmount, slippageBps);
    if (!sell) return null;
    return (1 - Number(sell.outAmount) / Number(lamports)) * 100;
  }

  async swapTx(q: Quote, user: string): Promise<VersionedTransaction> {
    const r = await this.f(`${this.base}/swap`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: q.raw, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`jupiter swap HTTP ${r.status}`);
    const { swapTransaction } = (await r.json()) as { swapTransaction?: string };
    if (!swapTransaction) throw new Error("jupiter returned no transaction");
    return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  }
}
