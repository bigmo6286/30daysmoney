/**
 * The Solana half of the CLI:
 *   sol-liquidity [--token USDC|SOL|<reserve>]
 *   sol-arb --mid <mint> [--token USDC] [--amount 1000] [--slippage-bps 30] [--min-profit 0.5] [--every 30] [--exec --yes]
 *
 * RPC: SOLANA_RPC_URL, else Alchemy (ALCHEMY_KEY), else the public RPC. The signing key comes
 * only from SOL_PRIVATE_KEY (base58 or a JSON byte array), and only `--exec` reads it.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { available, loadReserve } from "./kamino";
import { Jupiter } from "./jupiter";
import { findRoute, fmtUnits, quoteRoundTrip } from "./arb";

export function solanaRpc(env: NodeJS.ProcessEnv = process.env): string {
  const k = (env.ALCHEMY_KEY || "").trim();
  return (env.SOLANA_RPC_URL || (k ? `https://solana-mainnet.g.alchemy.com/v2/${k}` : "https://api.mainnet-beta.solana.com")).trim();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("SOL_PRIVATE_KEY isn't base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (const c of s) if (c === "1") out.unshift(0); else break;
  return Uint8Array.from(out);
}

export function solKeypair(env: NodeJS.ProcessEnv = process.env): Keypair {
  const raw = (env.SOL_PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("SOL_PRIVATE_KEY is required in the environment for --exec. Use a dedicated wallet.");
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : base58(raw);
  return Keypair.fromSecretKey(bytes);
}

const units = (s: string | true | undefined, dec: number, def: string) => {
  const v = typeof s === "string" ? s : def;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`not an amount: ${v}`);
  const [w, f = ""] = v.split(".");
  return BigInt(w!) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
};

/** Kamino's flash fee on the main market, measured on mainnet (Oct 2026): 0.001%. Quotes use 2× that as a margin; the simulation has the exact figure. */
const FEE_ESTIMATE_PPM = 20n;

export async function solMain(cmd: string, opts: Record<string, string | true>, log: (s: string) => void, env: NodeJS.ProcessEnv = process.env) {
  const conn = new Connection(solanaRpc(env), "confirmed");
  const r = await loadReserve(conn, typeof opts.token === "string" ? opts.token : "USDC");
  const sym = typeof opts.token === "string" ? opts.token.toUpperCase() : "USDC";
  if (cmd === "sol-liquidity") {
    return log(`Kamino main market can flash-lend up to ${fmtUnits(await available(conn, r), r.decimals)} ${sym} (Kamino's flash fee: 0.001% on USDC, measured; a dry run's simulation shows the exact figure)`);
  }
  if (cmd !== "sol-arb") throw new Error(`unknown command "${cmd}" (try: flash-kit help)`);

  if (typeof opts.mid !== "string") throw new Error("--mid <token mint> is required");
  const mid = new PublicKey(opts.mid).toBase58();
  const amount = units(opts.amount, r.decimals, "1000");
  const minProfit = units(opts["min-profit"], r.decimals, "0");
  const slip = Number(opts["slippage-bps"] ?? 30);
  const jup = new Jupiter(env.JUPITER_API_KEY || "");
  const exec = opts.exec === true;
  const kp = exec ? solKeypair(env) : null;
  // simulate as the real wallet when sending; otherwise any address works for the quote-only dry run
  const payer = kp?.publicKey ?? (env.SOL_ADDRESS ? new PublicKey(env.SOL_ADDRESS) : null);
  if (exec) {
    if (opts.yes !== true) throw new Error("sol-arb --exec sends a transaction: re-run with --yes once you've read the dry run");
    // the safety rule: the wallet holds none of the loan token, so only a route that returns
    // loan + fee can complete; with a balance, a losing route would quietly be paid from it
    const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(r.mint, kp!.publicKey, true, r.tokenProgram)).then((b) => BigInt(b.value.amount)).catch(() => 0n);
    if (bal > 0n) throw new Error(`the wallet holds ${fmtUnits(bal, r.decimals)} ${sym}: move it out first. With a balance, a losing round trip would be paid from it instead of failing.`);
  }

  const fee = (amount * FEE_ESTIMATE_PPM) / 1_000_000n;
  const once = async () => {
    const trip = await quoteRoundTrip(jup, r.mint.toBase58(), mid, amount, fee, slip);
    if (!trip) return log("no route");
    log(`${fmtUnits(amount, r.decimals)} ${sym} → ${trip.buy.route} → ${trip.sell.route} · expected ${fmtUnits(trip.expected, r.decimals)} ${sym} (worst ${fmtUnits(trip.worst, r.decimals)})`);
    if (trip.expected <= minProfit) return log(`  below your floor (${fmtUnits(minProfit, r.decimals)}): skipped`);
    if (!payer) return log("  set SOL_ADDRESS (your wallet's address) to simulate this route, or SOL_PRIVATE_KEY with --exec");
    const found = await findRoute(conn, jup, r, payer, mid, amount, fee, slip);
    if (!found) return log("  no route survived simulation");
    const { tx, built, excluded } = found;
    if (excluded.length) log(`  venues that refused inside a flash transaction, skipped: ${excluded.join(", ")}`);
    if (!built.ok) return log(`  simulation fails: ${built.error}`);
    log(`  simulated: ${fmtUnits(built.delta!, r.decimals)} ${sym} after the fee · ${built.units} CU · ${built.txSize} bytes`);
    if (built.delta! <= minProfit) return log("  below your floor after simulation: skipped");
    if (!exec) return log("  dry run: add --exec --yes to send");
    tx.sign([kp!]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const res = await conn.confirmTransaction(sig, "confirmed");
    log(`  sent ${sig} · ${res.value.err ? `failed: ${JSON.stringify(res.value.err)}` : "ok"}`);
  };
  await once();
  const every = Number(opts.every ?? 0);
  while (every > 0) {
    await new Promise((res) => setTimeout(res, every * 1000));
    await once().catch((e) => log(`  error: ${(e as Error).message}`));
  }
}
