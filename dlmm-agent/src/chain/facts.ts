/**
 * Observable facts about an SPL / Token-2022 mint, read from the chain. Hard red flags
 * (freeze authority, permanent delegate, transfer hooks, transfer fees, non-transferable)
 * are listed in `redFlags`; the gate rejects on any of them before asking a screener.
 */
import { PublicKey, type Connection } from "@solana/web3.js";

export interface MintFacts {
  mint: string;
  program: "spl-token" | "spl-token-2022" | "unknown";
  decimals: number;
  supply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names present on the mint */
  extensions: string[];
  transferFeeBps: number;
  /** share of supply held by the 10 largest accounts, excluding the pool being considered, % */
  top10Pct: number;
  /** share of supply in the pool's own reserve, % */
  inPoolPct: number;
  redFlags: string[];
}

export async function mintFacts(conn: Connection, mint: string, pool: string): Promise<MintFacts> {
  const key = new PublicKey(mint);
  const info = await conn.getParsedAccountInfo(key, "confirmed");
  const data = info.value?.data as any;
  if (!data?.parsed?.info) throw new Error(`${mint} is not a token mint`);
  const p = data.parsed.info;
  const program = data.program === "spl-token" || data.program === "spl-token-2022" ? data.program : "unknown";
  const exts: any[] = Array.isArray(p.extensions) ? p.extensions : [];
  const extensions = exts.map((e) => String(e.extension));
  const fee = exts.find((e) => e.extension === "transferFeeConfig")?.state;
  const transferFeeBps = Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? fee?.olderTransferFee?.transferFeeBasisPoints ?? 0);
  const supply = BigInt(p.supply ?? "0");

  let top10 = 0n;
  let inPool = 0n;
  try {
    const largest = (await conn.getTokenLargestAccounts(key, "confirmed")).value;
    const accs = await conn.getMultipleParsedAccounts(largest.map((a) => a.address), { commitment: "confirmed" });
    const held = largest.map((a, i) => ({ amount: BigInt(a.amount), owner: (accs.value[i]?.data as any)?.parsed?.info?.owner as string | undefined }));
    inPool = held.filter((h) => h.owner === pool).reduce((a, h) => a + h.amount, 0n);
    top10 = held
      .filter((h) => h.owner !== pool)
      .slice(0, 10)
      .reduce((a, h) => a + h.amount, 0n);
  } catch {
    // some RPCs rate-limit getTokenLargestAccounts; leave as 0 rather than block on it
  }
  const pctOf = (x: bigint) => (supply > 0n ? Number((x * 10_000n) / supply) / 100 : 0);

  const redFlags: string[] = [];
  if (p.freezeAuthority) redFlags.push("freeze authority set (holders can be frozen)");
  if (extensions.includes("permanentDelegate")) redFlags.push("permanent delegate (tokens can be moved from any wallet)");
  if (exts.some((e) => e.extension === "transferHook" && e.state?.programId)) redFlags.push("transfer hook program");
  if (extensions.includes("nonTransferable")) redFlags.push("non-transferable");
  if (extensions.includes("pausableConfig")) redFlags.push("transfers can be paused");
  if (transferFeeBps > 0) redFlags.push(`transfer fee ${transferFeeBps / 100}%`);

  return {
    mint,
    program,
    decimals: Number(p.decimals ?? 0),
    supply: supply.toString(),
    mintAuthority: p.mintAuthority ?? null,
    freezeAuthority: p.freezeAuthority ?? null,
    extensions,
    transferFeeBps,
    top10Pct: pctOf(top10),
    inPoolPct: pctOf(inPool),
    redFlags,
  };
}
