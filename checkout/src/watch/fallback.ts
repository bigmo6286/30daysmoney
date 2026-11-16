import type { Transfer } from "../orders";

/**
 * Public RPCs to fall back on, in order, when the configured one (usually Alchemy) refuses or is
 * down. Checked Nov 17: publicnode answers a 500-block USDC log query on Base; mainnet.base.org
 * refused it ("request limit reached").
 */
export const PUBLIC_RPC = {
  solana: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
  base: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
} as const;

export interface Watcher<S> {
  poll(): Promise<Transfer[]>;
  readonly state: S;
}

/**
 * Poll on the first RPC; if that poll throws, poll again on the next one, from the same saved
 * state. (A watcher only throws before it has moved its cursor, so retrying from `state` never
 * skips or repeats a payment.) Over Nov 15–16 Alchemy's monthly cap stopped every payment check
 * for about 40 hours; the public RPCs are slower and stricter but enough for one poll a pass.
 */
export async function pollWithFallback<S>(urls: string[], make: (url: string) => Watcher<S>, onFail: (url: string, err: unknown) => void = () => {}): Promise<{ transfers: Transfer[]; state: S; url: string }> {
  const list = [...new Set(urls.filter(Boolean))];
  let last: unknown = new Error("no RPC configured");
  for (const url of list) {
    const w = make(url);
    try {
      const transfers = await w.poll();
      return { transfers, state: w.state, url };
    } catch (err) {
      last = err;
      onFail(url, err);
    }
  }
  throw last;
}

/** An RPC URL without its key, for logs ("…/v2/abc123" → "…/v2/…"). */
export const redact = (url: string) => url.replace(/\/v2\/[^/?#]+/, "/v2/…").replace(/([?&](?:api[-_]?key|key|token)=)[^&]+/i, "$1…");
