/** Minimal JSON-RPC over fetch (Solana and EVM speak the same envelope). */
export async function rpc<T>(url: string, method: string, params: unknown[], f: typeof fetch = fetch): Promise<T> {
  const r = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message ?? "rpc error"}`);
  return j.result as T;
}
