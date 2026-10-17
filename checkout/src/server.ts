/**
 * HTTP: the landing page and a tiny JSON API. No keys or funds ever pass through here:
 * buyers pay the receiver wallet directly; the server only creates orders and reports status.
 */
import fs from "node:fs";
import http from "node:http";
import { z } from "zod";
import type { Product } from "./config";
import { fmtUsdc, type Chain, type Order, type OrderBook } from "./orders";
import { BASE_USDC } from "./watch/base";
import { SOL_USDC } from "./watch/solana";

export interface ServerDeps {
  book: OrderBook;
  products: Product[];
  receivers: Partial<Record<Chain, string>>;
  contact: string;
  html: string;
  trustProxy: boolean;
  /** orders per IP per hour */
  rateLimit?: number;
}

const NewOrder = z.object({
  product: z.string().max(40),
  chain: z.enum(["solana", "base"]),
  contact: z.string().trim().min(2).max(100),
});

export function payUrl(o: Order, receiver: string, label: string): string {
  const amt = fmtUsdc(o.amountMicro);
  if (o.chain === "solana") {
    return `solana:${receiver}?amount=${amt}&spl-token=${SOL_USDC}&label=${encodeURIComponent(label)}&message=${encodeURIComponent(`Order ${o.id}`)}`;
  }
  return `ethereum:${BASE_USDC}@8453/transfer?address=${receiver}&uint256=${o.amountMicro}`;
}

export function publicOrder(o: Order, d: ServerDeps) {
  const p = d.products.find((x) => x.id === o.product);
  const receiver = d.receivers[o.chain] ?? "";
  return {
    id: o.id,
    product: o.product,
    productName: p?.name ?? o.product,
    chain: o.chain,
    amount: fmtUsdc(o.amountMicro),
    receiver,
    token: o.chain === "solana" ? SOL_USDC : BASE_USDC,
    payUrl: payUrl(o, receiver, p?.name ?? "Order"),
    status: o.status,
    expiresAt: o.expiresAt,
    ...(o.status === "paid" ? { paid: o.paid, license: o.license, deliver: p?.deliver, contact: d.contact } : {}),
  };
}

export function createServer(d: ServerDeps) {
  const hits = new Map<string, number[]>();
  const limit = d.rateLimit ?? 10;
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const ipOf = (req: http.IncomingMessage) =>
    (d.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() : "") || req.socket.remoteAddress || "?";

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        });
        return void res.end(d.html);
      }
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/api/products") {
        return json(res, 200, { products: d.products.map(({ deliver: _d, ...p }) => p), chains: Object.keys(d.receivers), contact: d.contact });
      }
      if (req.method === "POST" && url.pathname === "/api/orders") {
        const ip = ipOf(req);
        const now = Date.now();
        const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
        if (recent.length >= limit) return json(res, 429, { error: "too many orders from this address, try again later" });
        const body = await readBody(req, 4096);
        const parsed = NewOrder.safeParse(JSON.parse(body || "{}"));
        if (!parsed.success) return json(res, 400, { error: "product, chain (solana|base) and a contact (Telegram @handle or email) are required" });
        const p = d.products.find((x) => x.id === parsed.data.product);
        if (!p) return json(res, 404, { error: "unknown product" });
        if (!d.receivers[parsed.data.chain]) return json(res, 400, { error: `${parsed.data.chain} payments are not enabled` });
        recent.push(now);
        hits.set(ip, recent);
        const o = d.book.create(p.id, p.priceUsd, parsed.data.chain, parsed.data.contact);
        return json(res, 201, publicOrder(o, d));
      }
      const m = /^\/api\/orders\/([\w-]{6,40})$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const o = d.book.get(m[1]!);
        return o ? json(res, 200, publicOrder(o, d)) : json(res, 404, { error: "no such order" });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, e instanceof SyntaxError ? 400 : 500, { error: e instanceof SyntaxError ? "invalid JSON" : "server error" });
    }
  });
}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new SyntaxError("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export const loadHtml = (file: URL) => fs.readFileSync(file, "utf8");
