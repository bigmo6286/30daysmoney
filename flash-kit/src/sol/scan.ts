/**
 * One unattended pass of the Solana flash-loan scanner, for a scheduled job:
 *   SOL_PRIVATE_KEY=… SOL_ADDRESS=… npm run scan
 *
 * Borrows USDC from Kamino, round-trips it through each watched token on Jupiter at a few sizes,
 * and sends only a route whose full simulation from this wallet clears ARB_MIN_PROFIT (USDC).
 * Refuses to run when the key doesn't match SOL_ADDRESS, when the wallet holds any USDC (a losing
 * route would be paid from it instead of failing), or when it's low on SOL for fees.
 * DRY_RUN=1 simulates but never sends. A Telegram message goes to the owner only for a send.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { loadReserve, type Reserve } from "./kamino";
import { Jupiter } from "./jupiter";
import { findRoute, fmtUnits, quoteRoundTrip } from "./arb";
import { solanaRpc, solKeypair } from "./cli";

/** Liquid but not top-tier tokens: where a gap between venues can still appear. */
export const MIDS: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
  POPCAT: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
};
const SIZES_USDC = [200n, 2_000n];
/** Kamino's flash fee measured on mainnet is 0.001%; quotes use 2× as a margin */
const FEE_PPM = 20n;
/** keep enough SOL for fees and the few token accounts Jupiter creates on first use */
const MIN_SOL_LAMPORTS = 20_000_000;
const SLIPPAGE_BPS = 30;
const BUDGET_MS = 150_000;

export interface Pass {
  checked: number;
  candidates: number;
  sent: { sig: string; profit: string; route: string }[];
  notes: string[];
}

async function notify(text: string, env: NodeJS.ProcessEnv) {
  const token = (env.SHOP_TG_TOKEN || "").trim();
  const chat = (env.TG_OWNER_ID || "").trim();
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

/** Why a pass must not run, if it must not: the safety checks, before any quote. */
export async function preflight(conn: Connection, r: Reserve, payer: PublicKey, expected: string): Promise<string | null> {
  if (payer.toBase58() !== expected) return `SOL_PRIVATE_KEY is for ${payer.toBase58()}, not SOL_ADDRESS ${expected}: refusing`;
  const lamports = await conn.getBalance(payer);
  if (lamports < MIN_SOL_LAMPORTS) return `wallet has ${lamports / 1e9} SOL; needs at least ${MIN_SOL_LAMPORTS / 1e9} for fees`;
  const usdc = await conn
    .getTokenAccountBalance(getAssociatedTokenAddressSync(r.mint, payer, true, r.tokenProgram))
    .then((b) => BigInt(b.value.amount))
    .catch(() => 0n);
  if (usdc > 0n) return `wallet holds ${fmtUnits(usdc, r.decimals)} USDC: move it out (with a balance, a losing route would be paid from it)`;
  return null;
}

export async function scanOnce(env: NodeJS.ProcessEnv = process.env): Promise<Pass> {
  const started = Date.now();
  const conn = new Connection(solanaRpc(env), "confirmed");
  const kp = solKeypair(env);
  const r = await loadReserve(conn, "USDC");
  const pass: Pass = { checked: 0, candidates: 0, sent: [], notes: [] };
  const stop = await preflight(conn, r, kp.publicKey, (env.SOL_ADDRESS || "").trim());
  if (stop) {
    pass.notes.push(stop);
    return pass;
  }
  const jup = new Jupiter(env.JUPITER_API_KEY || "");
  const minProfit = BigInt(Math.round(Number(env.ARB_MIN_PROFIT || "0.05") * 10 ** r.decimals));
  const dry = env.DRY_RUN === "1";
  for (const [sym, mid] of Object.entries(MIDS)) {
    for (const size of SIZES_USDC) {
      if (Date.now() - started > BUDGET_MS) {
        pass.notes.push("time budget used up");
        return pass;
      }
      const amount = size * 10n ** BigInt(r.decimals);
      pass.checked++;
      try {
        const trip = await quoteRoundTrip(jup, r.mint.toBase58(), mid, amount, (amount * FEE_PPM) / 1_000_000n, SLIPPAGE_BPS);
        if (!trip || trip.expected <= minProfit) continue;
        pass.candidates++;
        const found = await findRoute(conn, jup, r, kp.publicKey, mid, amount, (amount * FEE_PPM) / 1_000_000n, SLIPPAGE_BPS);
        if (!found || !found.built.ok || found.built.delta! <= minProfit) {
          pass.notes.push(`${sym} ${size}: quoted ${fmtUnits(trip.expected, 6)} but ${found?.built.ok ? `simulated ${fmtUnits(found.built.delta!, 6)}` : `simulation failed: ${found?.built.error ?? "no route"}`}`);
          continue;
        }
        const route = `${found.built.trip.buy.route} → ${found.built.trip.sell.route}`;
        if (dry) {
          pass.notes.push(`${sym} ${size}: would send, simulated +${fmtUnits(found.built.delta!, 6)} USDC via ${route}`);
          continue;
        }
        found.tx.sign([kp]);
        const sig = await conn.sendRawTransaction(found.tx.serialize(), { skipPreflight: false, maxRetries: 3 });
        const res = await conn.confirmTransaction(sig, "confirmed");
        if (res.value.err) {
          pass.notes.push(`${sym} ${size}: sent ${sig} but it failed on chain (the gap closed): ${JSON.stringify(res.value.err)}`);
          continue;
        }
        const profit = fmtUnits(found.built.delta!, 6);
        pass.sent.push({ sig, profit, route });
        await notify(`💰 Flash arb: +${profit} USDC (simulated) via ${sym}, ${size} USDC borrowed\n${route}\nhttps://solscan.io/tx/${sig}`, env);
      } catch (e) {
        pass.notes.push(`${sym} ${size}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  return pass;
}

if (process.argv[1]?.endsWith("scan.ts")) {
  scanOnce()
    .then((p) => {
      console.log(`scan: ${p.checked} quotes, ${p.candidates} candidates, ${p.sent.length} sent`);
      for (const n of p.notes) console.log(`  ${n}`);
      for (const s of p.sent) console.log(`  SENT +${s.profit} USDC ${s.sig}`);
    })
    .catch((e) => {
      console.error(`scan: ${(e as Error).message}`);
      process.exit(1);
    });
}
