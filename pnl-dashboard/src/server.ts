/** HTTP: the dashboard page, /api/summary (cached), /api/export.csv. Basic auth when a password is set. */
import crypto from "node:crypto";
import http from "node:http";
import { toCsv, type Summary } from "./model";

export interface ServerDeps {
  html: string;
  password: string;
  /** returns the cached summary, refreshing when stale */
  summary: (force?: boolean) => Promise<Summary>;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function createServer(d: ServerDeps) {
  return http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    if (d.password) {
      const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
      const pass = m ? Buffer.from(m[1]!, "base64").toString("utf8").split(":").slice(1).join(":") : "";
      if (!same(pass, d.password)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="pnl", charset="UTF-8"' });
        return void res.end("password required");
      }
    }
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method !== "GET") return void res.writeHead(405).end();
      if (url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        });
        return void res.end(d.html);
      }
      if (url.pathname === "/api/summary") {
        const s = await d.summary(url.searchParams.get("refresh") === "1");
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(s));
      }
      if (url.pathname === "/api/export.csv") {
        const s = await d.summary();
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="lp-pnl-${new Date(s.at).toISOString().slice(0, 10)}.csv"` });
        return void res.end(toCsv(s.rows));
      }
      if (url.pathname === "/healthz") return void res.writeHead(200).end("ok");
      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
    }
  });
}

/** Cache the summary; at most one refresh in flight, and forced refreshes are rate-limited. */
export function cached(load: () => Promise<Summary>, maxAgeMs: number, minForceGapMs = 15_000) {
  let last: Summary | null = null;
  let inflight: Promise<Summary> | null = null;
  return async (force = false): Promise<Summary> => {
    const age = last ? Date.now() - last.at : Infinity;
    if (last && age < maxAgeMs && !(force && age > minForceGapMs)) return last;
    inflight ??= load().finally(() => (inflight = null));
    last = await inflight;
    return last;
  };
}
