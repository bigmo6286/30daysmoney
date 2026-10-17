/** Dashboard config from .env (+ optional data/wallets.json). */
import path from "node:path";
import { z } from "zod";
import { readJson } from "./store";
import type { V3Chain } from "./sources/univ3";

import { V3_CHAINS } from "./chains";
export { V3_CHAINS };

const Wallet = z.object({
  chain: z.enum(["robinhood", "base", "arbitrum", "solana"]),
  address: z.string().min(32).max(64),
  label: z.string().max(40).optional(),
});
export type WalletCfg = z.infer<typeof Wallet>;

export interface DashConfig {
  host: string;
  port: number;
  password: string;
  refreshSec: number;
  chains: Record<string, V3Chain>;
  solanaRpc: string;
  lpBot?: { dataDir: string; chain: string };
  dlmmDataDir?: string;
  wallets: WalletCfg[];
}

/** "base:0xabc…,solana:Abc…" */
export function parseWallets(s: string): WalletCfg[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [chain, address, label] = x.split(":");
      return Wallet.parse({ chain, address, label });
    });
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): DashConfig {
  const host = (e.HOST || "127.0.0.1").trim();
  const password = (e.DASHBOARD_PASSWORD || "").trim();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!loopback && password.length < 12) throw new Error("listening beyond localhost needs DASHBOARD_PASSWORD (12+ characters)");
  const dataDir = path.resolve(e.DATA_DIR || "data");
  const fileWallets = z.array(Wallet).parse(readJson(path.join(dataDir, "wallets.json"), []));
  const chains: Record<string, V3Chain> = {};
  const alchemy = (slug: string) => (e.ALCHEMY_KEY?.trim() ? `https://${slug}.g.alchemy.com/v2/${e.ALCHEMY_KEY.trim()}` : "");
  for (const [k, { alchemy: slug, ...c }] of Object.entries(V3_CHAINS)) chains[k] = { ...c, rpcUrl: (e[`RPC_${k.toUpperCase()}`] || alchemy(slug) || c.rpcUrl).trim() };
  const lpChain = (e.LPBOT_CHAIN || "robinhood").toLowerCase();
  if (e.LPBOT_DATA && !chains[lpChain]) throw new Error(`LPBOT_CHAIN must be one of ${Object.keys(chains).join(", ")}`);
  return {
    host,
    port: Number(e.PORT || 8790),
    password,
    refreshSec: Number(e.REFRESH_SEC || 120),
    chains,
    // not Alchemy: finding a wallet's DLMM positions is a getProgramAccounts scan over the whole
    // program, which exceeds Alchemy's free-tier compute budget (429); the public RPC serves it
    solanaRpc: (e.RPC_SOLANA || "https://api.mainnet-beta.solana.com").trim(),
    lpBot: e.LPBOT_DATA ? { dataDir: path.resolve(e.LPBOT_DATA), chain: lpChain } : undefined,
    dlmmDataDir: e.DLMM_DATA ? path.resolve(e.DLMM_DATA) : undefined,
    wallets: [...fileWallets, ...parseWallets(e.WALLETS || "")],
  };
}
