/**
 * Jupiter (swap API v1) as instructions, to run inside a flash loan. The keyless lite endpoint
 * unless JUPITER_API_KEY is set.
 */
import { PublicKey, TransactionInstruction, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** the least the swap may return (after slippage) */
  minOut: bigint;
  route: string;
  /** venue labels on the route (to exclude on a retry) */
  labels: string[];
  raw: unknown;
}

interface RawIx {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Jupiter {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(apiKey = "", private readonly f: typeof fetch = fetch) {
    this.base = apiKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
    this.headers = apiKey ? { "x-api-key": apiKey } : {};
  }

  /** the keyless endpoint rate-limits hard: back off on 429 (1.5 s, 3 s, 6 s) */
  private async get(url: string, init: RequestInit = {}): Promise<Response> {
    for (let i = 0; ; i++) {
      const r = await this.f(url, { ...init, headers: { ...this.headers, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(20_000) });
      if (r.status !== 429 || i === 3) return r;
      await sleep(1500 * 2 ** i);
    }
  }

  /** null when there's no route. `maxAccounts` keeps the route small enough to fit next to a flash loan. */
  async quote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, excludeDexes: string[] = [], maxAccounts = 24): Promise<JupQuote | null> {
    const ex = excludeDexes.length ? `&excludeDexes=${encodeURIComponent(excludeDexes.join(","))}` : "";
    const url = `${this.base}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&maxAccounts=${maxAccounts}${ex}`;
    const r = await this.get(url);
    if (r.status === 400 || r.status === 404) return null;
    if (!r.ok) throw new Error(`jupiter quote HTTP ${r.status}`);
    const q = (await r.json()) as { inAmount?: string; outAmount?: string; otherAmountThreshold?: string; routePlan?: { swapInfo?: { label?: string } }[]; error?: string };
    if (q.error || !q.outAmount) return null;
    return {
      inputMint,
      outputMint,
      inAmount: BigInt(q.inAmount ?? amount),
      outAmount: BigInt(q.outAmount),
      minOut: BigInt(q.otherAmountThreshold ?? q.outAmount),
      route: (q.routePlan ?? []).map((p) => p.swapInfo?.label ?? "?").join(" → "),
      labels: [...new Set((q.routePlan ?? []).map((p) => p.swapInfo?.label).filter((l): l is string => !!l))],
      raw: q,
    };
  }

  /** The swap as instructions (setup, swap, cleanup) plus the lookup tables it needs; no compute-budget ixs (the flash tx sets its own). */
  async instructions(conn: Connection, q: JupQuote, user: PublicKey): Promise<{ instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[] }> {
    const r = await this.get(`${this.base}/swap-instructions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: q.raw, userPublicKey: user.toBase58(), wrapAndUnwrapSol: false, dynamicComputeUnitLimit: false }),
    });
    if (!r.ok) throw new Error(`jupiter swap-instructions HTTP ${r.status}`);
    const j = (await r.json()) as { setupInstructions?: RawIx[]; swapInstruction?: RawIx; cleanupInstruction?: RawIx | null; addressLookupTableAddresses?: string[]; error?: string };
    if (j.error || !j.swapInstruction) throw new Error(`jupiter: ${j.error ?? "no swap instruction"}`);
    const ix = (x: RawIx) =>
      new TransactionInstruction({ programId: new PublicKey(x.programId), keys: x.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(x.data, "base64") });
    const instructions = [...(j.setupInstructions ?? []).map(ix), ix(j.swapInstruction), ...(j.cleanupInstruction ? [ix(j.cleanupInstruction)] : [])];
    const lookupTables: AddressLookupTableAccount[] = [];
    for (const a of j.addressLookupTableAddresses ?? []) {
      const t = (await conn.getAddressLookupTable(new PublicKey(a))).value;
      if (t) lookupTables.push(t);
    }
    return { instructions, lookupTables };
  }
}
