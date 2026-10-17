/**
 * Incoming USDC on Solana: watch the receiver's USDC token account, read each new
 * transaction's token-balance deltas (works for transfer, transferChecked and inner
 * instructions alike).
 */
import { PublicKey } from "@solana/web3.js";
import type { Transfer } from "../orders";
import { rpc } from "./rpc";

export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function usdcAccount(owner: string, mint = SOL_USDC): string {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58();
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

/** USDC received by `account` in this transaction, and who it came from. Null if none. */
export function incoming(tx: any, account: string, mint = SOL_USDC): { amountMicro: number; from: string } | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const pre: TokenBalance[] = tx.meta.preTokenBalances ?? [];
  const post: TokenBalance[] = tx.meta.postTokenBalances ?? [];
  const bal = (list: TokenBalance[], i: number) => BigInt(list.find((b) => b.accountIndex === i && b.mint === mint)?.uiTokenAmount.amount ?? "0");
  const idx = keys.indexOf(account);
  if (idx < 0) return null;
  const delta = bal(post, idx) - bal(pre, idx);
  if (delta <= 0n) return null;
  // sender: the USDC account that lost the most
  let from = "unknown";
  let worst = 0n;
  for (const b of pre) {
    if (b.mint !== mint || b.accountIndex === idx) continue;
    const d = bal(post, b.accountIndex) - BigInt(b.uiTokenAmount.amount);
    if (d < worst) {
      worst = d;
      from = b.owner ?? keys[b.accountIndex] ?? "unknown";
    }
  }
  return { amountMicro: Number(delta), from };
}

export class SolanaWatcher {
  readonly account: string;
  private cursor: string | undefined;
  constructor(
    private readonly rpcUrl: string,
    owner: string,
    state: { cursor?: string },
    private readonly f: typeof fetch = fetch,
  ) {
    this.account = usdcAccount(owner);
    this.cursor = state.cursor;
  }

  get state() {
    return { cursor: this.cursor };
  }

  async poll(): Promise<Transfer[]> {
    const sigs = await rpc<{ signature: string; err: unknown; blockTime: number | null }[]>(
      this.rpcUrl,
      "getSignaturesForAddress",
      [this.account, { limit: 100, commitment: "confirmed", ...(this.cursor ? { until: this.cursor } : {}) }],
      this.f,
    );
    if (!sigs.length) return [];
    const out: Transfer[] = [];
    for (const s of [...sigs].reverse()) {
      if (s.err) continue;
      const tx = await rpc<any>(this.rpcUrl, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }], this.f);
      const got = incoming(tx, this.account);
      if (got) out.push({ chain: "solana", txid: s.signature, ...got, at: (tx?.blockTime ?? s.blockTime ?? Date.now() / 1000) * 1000 });
    }
    this.cursor = sigs[0]!.signature; // newest first
    return out;
  }
}
