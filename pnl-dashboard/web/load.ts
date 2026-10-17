/**
 * Everything the browser dashboard reads, wallet by wallet, straight from public RPCs:
 * Uniswap v3 on Robinhood Chain, Base and Arbitrum, Uniswap v4 on Robinhood Chain, and Meteora
 * DLMM on Solana (with an RPC the viewer supplies: Solana's public RPC refuses browsers).
 * A read that fails becomes a warning naming the wallet and chain, never a silent zero.
 */
import { ethers } from "ethers";
import { V3_CHAINS, V4_CHAINS } from "../src/chains";
import { readV3Positions, v3Rows } from "../src/sources/univ3";
import { readV4Positions } from "../src/sources/univ4";
import { summarize, type Row, type Summary } from "../src/model";

const JOBS_AT_ONCE = 4;

export interface Wallet {
  address: string;
  label?: string;
}

export type Kind = "evm" | "solana";

export function kindOf(address: string): Kind | null {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return "evm";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "solana";
  return null;
}

export interface LoadOptions {
  solanaRpc?: string;
  onProgress?: (done: number, total: number, what: string) => void;
}

const providers = new Map<string, ethers.JsonRpcProvider>();
const providerFor = (url: string, chainId: number) => {
  if (!providers.has(url)) providers.set(url, new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true }));
  return providers.get(url)!;
};

/** Which (wallet, source) reads failed, and which succeeded with how many positions. */
export interface Loaded extends Summary {
  failed: string[];
  counts: Record<string, number>;
}

export async function loadAll(wallets: Wallet[], o: LoadOptions = {}): Promise<Loaded> {
  const rows: Row[] = [];
  const warnings: string[] = [];
  const failed: string[] = [];
  const counts: Record<string, number> = {};
  const jobs: { key: string; what: string; run: () => Promise<Row[]> }[] = [];
  const name = (w: Wallet) => w.label || `${w.address.slice(0, 6)}…${w.address.slice(-4)}`;
  for (const w of wallets) {
    const kind = kindOf(w.address);
    if (kind === "evm") {
      for (const c of Object.values(V3_CHAINS)) {
        jobs.push({ key: `${w.address.toLowerCase()}|${c.name} v3`, what: `${name(w)} · ${c.name} v3`, run: async () => v3Rows(c, w.address, await readV3Positions(c, w.address, providerFor(c.rpcUrl, c.chainId))) });
      }
      for (const c of Object.values(V4_CHAINS)) {
        jobs.push({
          key: `${w.address.toLowerCase()}|${c.name} v4`,
          what: `${name(w)} · ${c.name} v4`,
          run: async () => v3Rows(c, w.address, await readV4Positions(c, w.address, providerFor(c.rpcUrl, c.chainId))).map((r) => ({ ...r, pair: `${r.pair} · v4` })),
        });
      }
    } else if (kind === "solana") {
      if (!o.solanaRpc) {
        warnings.push(`${name(w)}: add a Solana RPC in Settings to read Meteora positions (Solana's public RPC refuses browsers; a free Helius key works)`);
        continue;
      }
      jobs.push({
        key: `${w.address.toLowerCase()}|Solana DLMM`,
        what: `${name(w)} · Solana DLMM`,
        run: async () => {
          const sol = await import("./sol"); // the Solana libraries are most of the bundle: only loaded when needed
          return sol.dlmmRows(o.solanaRpc!, w.address);
        },
      });
    } else warnings.push(`${w.address}: not an EVM or Solana address`);
  }
  // a few at a time: each job already reads several positions in parallel, and the public RPCs
  // rate-limit a browser that fires everything at once
  let done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBS_AT_ONCE, jobs.length) }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++]!;
        try {
          const got = await j.run();
          rows.push(...got);
          counts[j.key] = got.length;
        } catch (e) {
          failed.push(j.key);
          warnings.push(`${j.what}: couldn't read (${(e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e})`.slice(0, 220));
        } finally {
          o.onProgress?.(++done, jobs.length, j.what);
        }
      }
    }),
  );
  return { ...summarize(rows, warnings), failed, counts };
}
