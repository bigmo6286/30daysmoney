/** Checkout configuration from .env, plus the product list (data/products.json overrides the defaults). */
import path from "node:path";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { readJson } from "./store";

export const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(80),
  priceUsd: z.number().positive().max(100_000),
  blurb: z.string().max(400),
  /** shown to the buyer once paid: download link, invite instructions, "we'll DM you within 12h"… */
  deliver: z.string().max(1000),
});
export type Product = z.infer<typeof ProductSchema>;

export const DEFAULT_PRODUCTS: Product[] = [
  {
    id: "lp-bot",
    name: "LP Bot Pro",
    priceUsd: 49,
    blurb: "Telegram Uniswap v3 LP bot for Robinhood Chain, Base and Arbitrum. Paper mode, simulated sends, range automation, autopilot with Jev token screening.",
    deliver: "Send your GitHub username to the Telegram contact below with your order id: you'll get access to the private repo and updates.",
  },
  {
    id: "lp-bot-setup",
    name: "LP Bot Pro + VPS setup",
    priceUsd: 99,
    blurb: "Everything in LP Bot Pro, installed and hardened on your own VPS. Your keys stay on your server.",
    deliver: "We'll message you on Telegram within 12 hours to schedule the setup. Keep your order id.",
  },
  {
    id: "dlmm-agent",
    name: "DLMM Agent Pro",
    priceUsd: 49,
    blurb: "Meteora DLMM agent for Solana: deterministic screening, safety gates, stop loss on by default, paper mode first.",
    deliver: "Send your GitHub username to the Telegram contact below with your order id: you'll get access to the private repo and updates.",
  },
  {
    id: "dlmm-agent-setup",
    name: "DLMM Agent Pro + VPS setup",
    priceUsd: 99,
    blurb: "Everything in DLMM Agent Pro, installed and hardened on your own VPS. Your keys stay on your server.",
    deliver: "We'll message you on Telegram within 12 hours to schedule the setup. Keep your order id.",
  },
];

export interface Config {
  port: number;
  dataDir: string;
  publicUrl: string;
  /** owner wallet on Solana (USDC goes to its associated token account) */
  solReceiver: string;
  solRpc: string;
  baseReceiver: string;
  baseRpc: string;
  licenseKey: string;
  tgToken: string;
  tgOwnerId: string;
  /** shown on the page so buyers can reach the seller */
  contact: string;
  orderTtlMin: number;
  pollSec: number;
  /** the X-Forwarded-For header is trusted for rate limiting only behind your own proxy */
  trustProxy: boolean;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const solReceiver = (e.SOL_RECEIVER || "").trim();
  const baseReceiver = (e.BASE_RECEIVER || "").trim();
  if (!solReceiver && !baseReceiver) throw new Error("set SOL_RECEIVER and/or BASE_RECEIVER: the wallet(s) that receive USDC");
  if (solReceiver) {
    try {
      if (!PublicKey.isOnCurve(new PublicKey(solReceiver).toBytes())) throw new Error();
    } catch {
      throw new Error("SOL_RECEIVER must be a normal Solana wallet address (not a token account)");
    }
  }
  if (baseReceiver && !/^0x[0-9a-fA-F]{40}$/.test(baseReceiver)) throw new Error("BASE_RECEIVER must be a 0x address");
  const licenseKey = (e.LICENSE_PRIVATE_KEY || "").trim();
  if (!licenseKey) throw new Error("LICENSE_PRIVATE_KEY is required: run `npm run keygen` once and put the private key in .env");
  return {
    port: Number(e.PORT || 8787),
    dataDir: path.resolve(e.DATA_DIR || "data"),
    publicUrl: (e.PUBLIC_URL || "").trim(),
    solReceiver,
    solRpc: (e.SOL_RPC_URL || "https://api.mainnet-beta.solana.com").trim(),
    baseReceiver,
    baseRpc: (e.BASE_RPC_URL || "https://mainnet.base.org").trim(),
    licenseKey,
    tgToken: (e.TG_TOKEN || "").trim(),
    tgOwnerId: (e.TG_OWNER_ID || "").trim(),
    contact: (e.CONTACT || "").trim(),
    orderTtlMin: Number(e.ORDER_TTL_MIN || 60),
    pollSec: Number(e.POLL_SEC || 15),
    trustProxy: /^(1|true|yes)$/i.test(e.TRUST_PROXY || ""),
  };
}

export function loadProducts(dataDir: string): Product[] {
  const raw = readJson<unknown>(path.join(dataDir, "products.json"), null);
  if (raw === null) return DEFAULT_PRODUCTS;
  return z.array(ProductSchema).min(1).parse(raw);
}
