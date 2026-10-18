/**
 * Orders with unique amounts. Each order's price gets a 1–9999 micro-USDC suffix
 * ($49.000137), unique per chain and price over the last week, so a plain USDC transfer
 * identifies its order with no memo or wallet integration.
 */
import crypto from "node:crypto";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./store";

export type Chain = "solana" | "base";

export interface Transfer {
  chain: Chain;
  txid: string;
  /** USDC, 6 decimals */
  amountMicro: number;
  from: string;
  /** ms since epoch (block time) */
  at: number;
}

export interface Order {
  id: string;
  product: string;
  chain: Chain;
  amountMicro: number;
  contact: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "paid" | "expired";
  paid?: { txid: string; from: string; at: number; late: boolean };
  /** where the buyer came from (store link ?ref=), for seeing which channel sells */
  ref?: string;
  license?: string;
  /** when the buyer was told their subscription is about to run out */
  reminded?: number;
}

interface File {
  orders: Order[];
  /** every txid ever matched, so a re-scanned transfer can't pay twice */
  seen: string[];
}

const SUFFIX_MAX = 9_999;
const REUSE_AFTER_MS = 7 * 86_400_000;
/** a transfer may land slightly before the order is saved (clock skew between us and the chain) */
const EARLY_SLACK_MS = 120_000;

export const fmtUsdc = (micro: number) => (micro / 1e6).toFixed(6);

export class OrderBook {
  private file: string;
  private data: File;
  constructor(
    dataDir: string,
    private readonly ttlMs = 60 * 60_000,
    private readonly now = () => Date.now(),
  ) {
    this.file = path.join(dataDir, "orders.json");
    this.data = readJson<File>(this.file, { orders: [], seen: [] });
  }

  private save() {
    writeJsonAtomic(this.file, this.data);
  }

  get(id: string): Order | undefined {
    return this.data.orders.find((o) => o.id === id);
  }

  all(): Order[] {
    return this.data.orders;
  }

  create(product: string, priceUsd: number, chain: Chain, contact: string, ref?: string): Order {
    const base = Math.round(priceUsd * 1e6);
    const t = this.now();
    const taken = new Set(
      this.data.orders.filter((o) => o.chain === chain && o.createdAt > t - REUSE_AFTER_MS && Math.abs(o.amountMicro - base) <= SUFFIX_MAX).map((o) => o.amountMicro - base),
    );
    if (taken.size >= SUFFIX_MAX) throw new Error("too many open orders at this price; try again later");
    let suffix: number;
    do suffix = 1 + crypto.randomInt(SUFFIX_MAX);
    while (taken.has(suffix));
    const o: Order = {
      id: crypto.randomBytes(8).toString("base64url"),
      product,
      chain,
      amountMicro: base + suffix,
      contact,
      createdAt: t,
      expiresAt: t + this.ttlMs,
      status: "pending",
      ...(ref ? { ref } : {}),
    };
    this.data.orders.push(o);
    this.save();
    return o;
  }

  /** Mark the order this transfer pays, if any. Late payments to expired orders still count. */
  match(tr: Transfer): Order | null {
    if (this.data.seen.includes(tr.txid)) return null;
    const o = this.data.orders.find(
      (x) => x.chain === tr.chain && x.amountMicro === tr.amountMicro && x.status !== "paid" && tr.at >= x.createdAt - EARLY_SLACK_MS && tr.at - x.createdAt < REUSE_AFTER_MS,
    );
    if (!o) return null;
    o.status = "paid";
    o.paid = { txid: tr.txid, from: tr.from, at: tr.at, late: tr.at > o.expiresAt };
    this.data.seen.push(tr.txid);
    this.save();
    return o;
  }

  setLicense(id: string, license: string) {
    const o = this.get(id);
    if (o) {
      o.license = license;
      this.save();
    }
  }

  setReminded(id: string, at: number) {
    const o = this.get(id);
    if (o) {
      o.reminded = at;
      this.save();
    }
  }

  expire(): Order[] {
    const t = this.now();
    const out = this.data.orders.filter((o) => o.status === "pending" && o.expiresAt < t);
    for (const o of out) o.status = "expired";
    if (out.length) this.save();
    return out;
  }
}
