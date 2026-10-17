/** Dashboard config from .env (+ optional data/wallets.json). */
import path from "node:path";
import { z } from "zod";
import { readJson } from "./store";
import type { V3Chain } from "./sources/univ3";

/** `alchemy`: network slug used instead of the public RPC when ALCHEMY_KEY is set. */
export const V3_CHAINS: Record<string, V3Chain & { alchemy: string }> = {
  robinhood: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    alchemy: "robinhood-mainnet",
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    stables: [{ address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 }], // USDG
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    alchemy: "base-mainnet",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    weth: "0x4200000000000000000000000000000000000006",
    stables: [{ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }], // USDC
  },
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    alchemy: "arb-mainnet",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    stables: [{ address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }], // USDC
  },
};

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
