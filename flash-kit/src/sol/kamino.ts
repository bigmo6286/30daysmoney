/**
 * Kamino Lend flash loans on Solana: borrow → your instructions → repay, in one transaction.
 *
 * Rebuild of kamino-tools' flash builder, without its SDK: the two instructions are small, so
 * they are built here from the reserve account read on chain (mint, supply vault, fee vault),
 * and the reserve is checked before use (owner program, discriminator, vaults held by the
 * market's authority). The repay has to land in the same transaction or klend rejects the
 * borrow, so a strategy that comes up short fails as a whole: the loan can't be kept.
 */
import crypto from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const KLEND = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
/** Main-market reserves (checked on chain at load time, so a wrong entry fails loudly). */
export const RESERVES: Record<string, string> = {
  USDC: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
  SOL: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
};

const disc = (name: string) => crypto.createHash("sha256").update(`${name}`).digest().subarray(0, 8);
/** Anchor account discriminator of klend's Reserve */
export const RESERVE_DISC = disc("account:Reserve");
const BORROW = disc("global:flash_borrow_reserve_liquidity");
const REPAY = disc("global:flash_repay_reserve_liquidity");

export interface Reserve {
  address: PublicKey;
  market: PublicKey;
  mint: PublicKey;
  supplyVault: PublicKey;
  feeVault: PublicKey;
  marketAuthority: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

export const marketAuthority = (market: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("lma"), market.toBuffer()], KLEND)[0];

/** Byte offsets in the Reserve account (after the 8-byte discriminator: version, last_update, market, farms, then liquidity). */
const OFF = { market: 32, mint: 128, supplyVault: 160, feeVault: 192 };

export function decodeReserve(address: PublicKey, owner: PublicKey, data: Buffer): Omit<Reserve, "tokenProgram" | "decimals"> {
  if (!owner.equals(KLEND)) throw new Error(`${address.toBase58()} isn't a Kamino Lend account (owner ${owner.toBase58()})`);
  if (data.length < 224 || !data.subarray(0, 8).equals(RESERVE_DISC)) throw new Error(`${address.toBase58()} isn't a Kamino reserve`);
  const pk = (o: number) => new PublicKey(data.subarray(o, o + 32));
  const market = pk(OFF.market);
  return { address, market, mint: pk(OFF.mint), supplyVault: pk(OFF.supplyVault), feeVault: pk(OFF.feeVault), marketAuthority: marketAuthority(market) };
}

export async function loadReserve(conn: Connection, reserve: string): Promise<Reserve> {
  const address = new PublicKey(RESERVES[reserve.toUpperCase()] ?? reserve);
  const acc = await conn.getAccountInfo(address);
  if (!acc) throw new Error(`reserve ${address.toBase58()} not found`);
  const r = decodeReserve(address, acc.owner, acc.data);
  const [mint, vault] = await conn.getMultipleAccountsInfo([r.mint, r.supplyVault]);
  if (!mint || !vault) throw new Error("reserve mint or vault missing");
  // SPL token account: mint at 0, owner at 32. The vault must hold this mint for the market's authority.
  if (!new PublicKey(vault.data.subarray(0, 32)).equals(r.mint) || !new PublicKey(vault.data.subarray(32, 64)).equals(r.marketAuthority)) {
    throw new Error("reserve vault doesn't match its mint / market authority: refusing to build against it");
  }
  return { ...r, tokenProgram: mint.owner, decimals: mint.data[44]! };
}

/** Liquidity the reserve can flash-lend right now (raw units): what sits in its supply vault. */
export async function available(conn: Connection, r: Reserve): Promise<bigint> {
  const b = await conn.getTokenAccountBalance(r.supplyVault);
  return BigInt(b.value.amount);
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

function keys(r: Reserve, user: PublicKey, userToken: PublicKey) {
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  return [
    k(user, false, true),
    k(r.marketAuthority),
    k(r.market),
    k(r.address, true),
    k(r.mint),
    k(r.supplyVault, true),
    k(userToken, true),
    k(r.feeVault, true),
    k(KLEND), // referrer token state: none
    k(KLEND), // referrer account: none
    k(SYSVAR_INSTRUCTIONS_PUBKEY),
    k(r.tokenProgram),
  ];
}

export function flashBorrowIx(r: Reserve, user: PublicKey, amount: bigint): TransactionInstruction {
  const userToken = getAssociatedTokenAddressSync(r.mint, user, true, r.tokenProgram);
  return new TransactionInstruction({ programId: KLEND, keys: keys(r, user, userToken), data: Buffer.concat([BORROW, u64(amount)]) });
}

/** Repays `amount`; klend adds its flash fee and pulls amount + fee from the user's token account. */
export function flashRepayIx(r: Reserve, user: PublicKey, amount: bigint, borrowIndex: number): TransactionInstruction {
  const userToken = getAssociatedTokenAddressSync(r.mint, user, true, r.tokenProgram);
  const k = keys(r, user, userToken);
  // repay: same accounts, user's token account is the source and the vault the destination
  return new TransactionInstruction({ programId: KLEND, keys: k, data: Buffer.concat([REPAY, u64(amount), Buffer.from([borrowIndex])]) });
}

export interface FlashPlan {
  payer: PublicKey;
  reserve: Reserve;
  amount: bigint;
  /** what to do with the borrowed tokens; must leave at least amount + fee in the payer's token account */
  strategy: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
  computeUnits?: number;
  priorityMicroLamports?: number;
}

/** compute budget, the payer's token account (created if missing), borrow, strategy, repay */
export function flashInstructions(p: FlashPlan): TransactionInstruction[] {
  const head = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnits ?? 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityMicroLamports ?? 0 }),
    createAssociatedTokenAccountIdempotentInstruction(p.payer, getAssociatedTokenAddressSync(p.reserve.mint, p.payer, true, p.reserve.tokenProgram), p.payer, p.reserve.mint, p.reserve.tokenProgram),
  ];
  const borrowIndex = head.length;
  return [...head, flashBorrowIx(p.reserve, p.payer, p.amount), ...p.strategy, flashRepayIx(p.reserve, p.payer, p.amount, borrowIndex)];
}

export async function flashTransaction(conn: Connection, p: FlashPlan): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: p.payer, recentBlockhash: blockhash, instructions: flashInstructions(p) }).compileToV0Message(p.lookupTables ?? []);
  return new VersionedTransaction(msg);
}

export interface SimResult {
  ok: boolean;
  error?: string;
  logs: string[];
  units?: number;
  /** change in the payer's balance of the loan token (raw), after repaying: the profit, or minus the fee */
  delta?: bigint;
}

/** Simulate as the payer without a signature: shows exactly what the transaction would do now. */
export async function simulateFlash(conn: Connection, tx: VersionedTransaction, p: Pick<FlashPlan, "payer" | "reserve">): Promise<SimResult> {
  const ata = getAssociatedTokenAddressSync(p.reserve.mint, p.payer, true, p.reserve.tokenProgram);
  const before = await conn.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [ata.toBase58()] } });
  const v = sim.value;
  const logs = v.logs ?? [];
  if (v.err) return { ok: false, error: explain(v.err, logs), logs, units: v.unitsConsumed };
  const acc = v.accounts?.[0];
  const after = acc ? Buffer.from(acc.data[0] ?? "", "base64").readBigUInt64LE(64) : 0n;
  return { ok: true, logs, units: v.unitsConsumed, delta: after - before };
}

/** The useful part of a failed simulation: klend's or the token program's own message. */
export function explain(err: unknown, logs: string[]): string {
  const hit = logs.find((l) => /Error Message:|insufficient funds|custom program error/i.test(l));
  return hit ? hit.replace(/^Program log: /, "").trim() : JSON.stringify(err);
}
