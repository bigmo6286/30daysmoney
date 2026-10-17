/** Minimal JSON-RPC over fetch (Solana and EVM speak the same envelope). Rate limits (429) are retried with backoff. */
export async function rpc<T>(url: string, method: string, params: unknown[], f: typeof fetch = fetch, retries = 3, backoffMs = 1_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce<T>(url, method, params, f);
    } catch (e) {
      if (!(e instanceof RateLimited) || attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
    }
  }
}

export class RateLimited extends Error {}

async function rpcOnce<T>(url: string, method: string, params: unknown[], f: typeof fetch): Promise<T> {
  const r = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 429) throw new RateLimited(`${method}: HTTP 429 (rate limited)`);
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (j.error) {
    const msg = j.error.message ?? "rpc error";
    // some nodes signal rate limits inside a 200 response (e.g. Base's public RPC: -32011 "request limit reached")
    if (j.error.code === -32011 || j.error.code === -32005 || /rate limit|limit reached|too many requests/i.test(msg)) throw new RateLimited(`${method}: ${msg}`);
    throw new Error(`${method}: ${msg}`);
  }
  return j.result as T;
}
