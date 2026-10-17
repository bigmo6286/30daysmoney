/**
 * Solana connection, wallet, and one careful send path:
 * priority fee → measured compute limit → simulate (abort on error, no fee spent) → send →
 * re-broadcast until confirmed or the blockhash expires. Sends are serialized.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../log";

const log = logger("sol");
const LAMPORTS = 1e9;
const MAX_CU = 1_400_000;

export function loadKeypair(key: string): Keypair {
  const k = key.trim();
  if (k.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(k) as number[]));
  return Keypair.fromSecretKey(bs58.decode(k));
}

export function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

const isBudget = (ix: TransactionInstruction, kind: 2 | 3) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === kind;

export class Solana {
  readonly connection: Connection;
  readonly address: PublicKey;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    rpcUrl: string,
    private readonly payer: Keypair | null,
    watchAddress?: string,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.address = payer?.publicKey ?? new PublicKey(watchAddress || PublicKey.default);
  }

  get canSign() {
    return this.payer !== null;
  }

  async balanceSol(): Promise<number> {
    return (await this.connection.getBalance(this.address, "confirmed")) / LAMPORTS;
  }

  /** Raw token balance across all of the wallet's accounts for `mint` (SPL and Token-2022). */
  async tokenBalance(mint: PublicKey): Promise<bigint> {
    const r = await this.connection.getParsedTokenAccountsByOwner(this.address, { mint }, "confirmed");
    return r.value.reduce((a, acc) => a + BigInt((acc.account.data as any).parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
  }

  /** Median recent priority fee (µlamports/CU) for these accounts, floored so sends still land when quiet. */
  async priorityFee(accounts: PublicKey[], fixed: number): Promise<number> {
    if (fixed > 0) return fixed;
    try {
      const fees = (await this.connection.getRecentPrioritizationFees({ lockedWritableAccounts: accounts.slice(0, 128) }))
        .map((f) => f.prioritizationFee)
        .sort((a, b) => a - b);
      const median = fees.length ? fees[Math.floor(fees.length / 2)]! : 0;
      return Math.min(2_000_000, Math.max(10_000, median));
    } catch {
      return 50_000;
    }
  }

  /** Build a v0 transaction from instructions (adding compute budget if absent), simulate, send. */
  sendInstructions(ixs: TransactionInstruction[], extraSigners: Keypair[], microLamports: number): Promise<string> {
    return this.serial(async () => {
      const payer = this.requirePayer();
      const body = ixs.filter((ix) => !isBudget(ix, 3)); // our price replaces any the SDK set
      const keys = body.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey));
      const price = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await this.priorityFee(keys, microLamports) });
      const hasLimit = body.some((ix) => isBudget(ix, 2));
      const build = (limit: number | null, blockhash: string) => {
        const pre = limit === null ? [price] : [price, ComputeBudgetProgram.setComputeUnitLimit({ units: limit })];
        const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [...pre, ...body] }).compileToV0Message();
        const tx = new VersionedTransaction(msg);
        tx.sign([payer, ...extraSigners]);
        return tx;
      };
      const bh = await this.connection.getLatestBlockhash("confirmed");
      let tx = build(hasLimit ? null : MAX_CU, bh.blockhash);
      const units = await this.simulate(tx);
      if (!hasLimit) tx = build(Math.min(MAX_CU, Math.ceil(units * 1.2) + 10_000), bh.blockhash);
      return this.broadcast(tx, bh.lastValidBlockHeight);
    });
  }

  /** Sign, simulate and send a transaction someone else built (e.g. a Jupiter swap). */
  sendVersioned(tx: VersionedTransaction): Promise<string> {
    return this.serial(async () => {
      tx.sign([this.requirePayer()]);
      await this.simulate(tx);
      const bh = await this.connection.getLatestBlockhash("confirmed");
      return this.broadcast(tx, bh.lastValidBlockHeight);
    });
  }

  private async simulate(tx: VersionedTransaction): Promise<number> {
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-6).join(" | ");
      throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ` · ${logs}` : ""}`);
    }
    return sim.value.unitsConsumed ?? 200_000;
  }

  private async broadcast(tx: VersionedTransaction, lastValidBlockHeight: number): Promise<string> {
    const raw = tx.serialize();
    const sig = await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    for (;;) {
      await new Promise((r) => setTimeout(r, 2_000));
      const st = (await this.connection.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        log.info(`confirmed ${sig}`);
        return sig;
      }
      if ((await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        throw new Error(`tx ${sig} expired before confirming (it did not land)`);
      }
      await this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }

  private requirePayer(): Keypair {
    if (!this.payer) throw new Error("no wallet key: paper mode never sends");
    return this.payer;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
