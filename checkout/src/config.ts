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
  /** a subscription: the key expires this many days after payment (renewing early adds on) */
  days: z.number().int().positive().max(3650).optional(),
  /** what the key is for, for the delivery message: a bot's .env (default), the dashboard, or nothing */
  keyFor: z.enum(["bot", "dashboard", "none"]).optional(),
});
export type Product = z.infer<typeof ProductSchema>;

export const DEFAULT_PRODUCTS: Product[] = [
  {
    id: "lp-bot",
    name: "LP Bot Pro",
    priceUsd: 49,
    blurb: "Telegram LP bot for Uniswap v3 and v4 on Robinhood Chain, Base and Arbitrum. Pro unlocks the autopilot with Jev token screening, auto-rebalance and daily reports.",
    deliver: "Install: github.com/bigmo6286/30daysmoney/tree/main/lp-bot (or setup-scripts/ for a one-command VPS install). Updates are free.",
  },
  {
    id: "lp-bot-setup",
    name: "LP Bot Pro + VPS setup",
    priceUsd: 99,
    blurb: "Everything in LP Bot Pro, installed and hardened on your own VPS. Your keys stay on your server.",
    deliver: "Message the contact below with your order id to book the setup; we reply within 12 hours. Your key also unlocks Pro.",
  },
  {
    id: "dlmm-agent",
    name: "DLMM Agent Pro",
    priceUsd: 49,
    blurb: "Meteora DLMM agent for Solana: deterministic screening, safety gates, stop loss on by default, paper mode first. Pro unlocks the autopilot and daily reports.",
    deliver: "Install: github.com/bigmo6286/30daysmoney/tree/main/dlmm-agent (or setup-scripts/ for a one-command VPS install). Updates are free.",
  },
  {
    id: "dlmm-agent-setup",
    name: "DLMM Agent Pro + VPS setup",
    priceUsd: 99,
    blurb: "Everything in DLMM Agent Pro, installed and hardened on your own VPS. Your keys stay on your server.",
    deliver: "Message the contact below with your order id to book the setup; we reply within 12 hours. Your key also unlocks Pro.",
  },
  {
    id: "flash-guide",
    name: "Flash-loan arbitrage guide",
    priceUsd: 19,
    blurb: "Build a flash-loan executor that can't be drained and reverts unless it profits: Morpho Blue + Uniswap v3 on Robinhood Chain, Base and Ethereum, with real sizing, gas and mainnet-fork numbers.",
    deliver: "Read it here (bookmark it; the link is your copy): {{GUIDE_URL:flash-loans}}",
    keyFor: "none",
  },
  {
    id: "pnl-pro",
    name: "LP PnL Dashboard Pro (30 days)",
    priceUsd: 15,
    blurb: "Every Uniswap v3/v4 and Meteora DLMM position across up to 20 wallets: value, unclaimed fees, range, with history charts, CSV export, auto-refresh, and Telegram alerts when a position leaves its range. Read-only.",
    deliver: "Open {{STORE_URL}}dashboard/ and paste your key in Settings. For range alerts, send /watch 0x… here. Renew any time with /buy: the new key adds 30 days to whatever is left.",
    days: 30,
    keyFor: "dashboard",
  },
  {
    id: "pnl-lifetime",
    name: "LP PnL Dashboard Pro (lifetime)",
    priceUsd: 39,
    blurb: "Dashboard Pro with no renewals: up to 20 wallets, history, CSV, auto-refresh, range alerts on Telegram, and every update.",
    deliver: "Open {{STORE_URL}}dashboard/ and paste your key in Settings. For range alerts, send /watch 0x… here. It never expires.",
    keyFor: "dashboard",
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
    solRpc: (e.SOL_RPC_URL || (e.ALCHEMY_KEY ? `https://solana-mainnet.g.alchemy.com/v2/${e.ALCHEMY_KEY.trim()}` : "https://api.mainnet-beta.solana.com")).trim(),
    baseReceiver,
    baseRpc: (e.BASE_RPC_URL || (e.ALCHEMY_KEY ? `https://base-mainnet.g.alchemy.com/v2/${e.ALCHEMY_KEY.trim()}` : "https://mainnet.base.org")).trim(),
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
