/**
 * Runtime configuration.
 *   .env               → secrets + chain selection (never committed)
 *   data/settings.json → tunables, editable live from Telegram with /set
 */
import path from "node:path";
import { z } from "zod";
import { proOnly } from "./license";
import { ethers } from "ethers";
import { CHAINS, type ChainPreset } from "./chains";
import { readJson, writeJsonAtomic } from "./store";

export const SettingsSchema = z.object({
  /** In-range width: ± this % around the current token price. */
  widthPct: z.number().positive().max(95).default(20),
  /** Single-side ranges sit this % below the current price and span widthPct downward. */
  singleOffsetPct: z.number().min(0).max(50).default(1),
  slippagePct: z.number().min(0.05).max(50).default(3),
  /** Native ETH never touched by opens — keeps gas for closes. */
  gasReserveEth: z.number().min(0).default(0.005),
  feeTiers: z.array(z.number().int()).nonempty().default([100, 500, 3000, 10000]),
  monitorSec: z.number().int().min(10).default(60),
  alertOutOfRange: z.boolean().default(true),
  /** Close + reopen around the new price once a position has been out of range this long. */
  autoRebalance: z.boolean().default(false),
  rebalanceGraceMin: z.number().min(0).default(15),
  /** Auto-close at +tpPct / −slPct PnL (vs deposit). 0 = off. */
  tpPct: z.number().min(0).default(0),
  slPct: z.number().min(0).default(0),
  /** Swap the token side back to ETH on close. */
  swapToEthOnClose: z.boolean().default(true),

  // ── autopilot: scan pools, open the best within caps, rotate out of faded ones ──
  /** Master switch for auto-opening/closing. The scanner (/scan) runs regardless. */
  autoEnabled: z.boolean().default(false),
  autoScanMin: z.number().min(1).default(5),
  autoSizeEth: z.number().positive().default(0.01),
  autoMaxOpen: z.number().int().min(0).default(3),
  /** Max ETH the autopilot may commit per UTC day. */
  autoDailyEth: z.number().min(0).default(0.05),
  autoMode: z.enum(["single", "inrange"]).default("inrange"),
  /** Only open pools whose measured fee yield (APR, for a position of autoSizeEth) is at least this. */
  autoMinAprPct: z.number().min(0).default(200),
  /** Minimum WETH held by the pool. */
  autoMinDepthEth: z.number().min(0).default(1),
  /** Skip pools whose price moved more than this between two scans. */
  autoMaxMovePct: z.number().min(0).default(10),
  /** Close an auto position whose pool yield fell below this (after autoGraceMin). 0 = off. */
  autoExitAprPct: z.number().min(0).default(50),
  autoGraceMin: z.number().min(0).default(60),
  /** Close an auto position that has been out of range this long. 0 = off. */
  autoCloseOorMin: z.number().min(0).default(60),
  /** Don't re-enter a token the autopilot just exited for this long. */
  autoCooldownHours: z.number().min(0).default(12),
  /** Ask the screener (Jev) about each token before auto-opening. On without TYPESAFE_API_KEY = no opens. */
  autoScreen: z.boolean().default(true),
  /** Block an open when the screener's probability (%) is above these. */
  autoMaxCopycatPct: z.number().min(0).max(100).default(50),
  autoMaxRugPct: z.number().min(0).max(100).default(40),
  autoMaxRiskPct: z.number().min(0).max(100).default(60),
  dailyReport: z.boolean().default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

export type Mode = "paper" | "live";

export interface AppConfig {
  mode: Mode;
  chain: ChainPreset;
  rpcUrl: string;
  /** eth_getLogs (the scanner) goes here: Alchemy's free tier allows only 10 blocks per call */
  logsRpcUrl: string;
  walletKey: string;
  paperAddress: string;
  tgToken: string;
  tgOwnerId: string;
  dataDir: string;
  /** TypeSafe key for Jev token screening; empty = no screener */
  /** Pro license from checkout; empty = free tier */
  licenseKey: string;
  typesafeKey: string;
  jevModel: string;
}

function chainFromEnv(e: NodeJS.ProcessEnv): ChainPreset {
  const key = (e.CHAIN || "robinhood").toLowerCase();
  const base: ChainPreset =
    CHAINS[key] ??
    ({
      name: e.CHAIN_NAME || "Custom",
      chainId: Number(e.CHAIN_ID || 0),
      rpcUrl: "",
      explorer: e.EXPLORER_URL || "",
      nativeSymbol: "ETH",
      contracts: { factory: "", positionManager: "", swapRouter02: "", quoterV2: "", weth: "" },
    } satisfies ChainPreset);
  const c = base.contracts;
  const chain: ChainPreset = {
    ...base,
    chainId: Number(e.CHAIN_ID || base.chainId),
    explorer: e.EXPLORER_URL || base.explorer,
    contracts: {
      factory: e.V3_FACTORY || c.factory,
      positionManager: e.V3_POSITION_MANAGER || c.positionManager,
      swapRouter02: e.V3_SWAP_ROUTER02 || c.swapRouter02,
      quoterV2: e.V3_QUOTER_V2 || c.quoterV2,
      weth: e.WETH || c.weth,
    },
  };
  for (const [k, v] of Object.entries(chain.contracts)) {
    if (!ethers.isAddress(v)) throw new Error(`contract address "${k}" missing or invalid for chain ${chain.name}`);
  }
  if (!chain.chainId) throw new Error("CHAIN_ID is required for CHAIN=custom");
  return chain;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode: Mode = (e.MODE || "paper").toLowerCase() === "live" ? "live" : "paper";
  const chain = chainFromEnv(e);
  const alchemyKey = (e.ALCHEMY_KEY || "").trim();
  const rpcUrl = (e.RPC_URL || (alchemyKey && chain.alchemy ? `https://${chain.alchemy}.g.alchemy.com/v2/${alchemyKey}` : chain.rpcUrl)).trim();
  if (!rpcUrl) throw new Error("RPC_URL is required");
  const viaAlchemy = !e.RPC_URL && rpcUrl !== chain.rpcUrl;
  const logsRpcUrl = (e.LOGS_RPC_URL || (viaAlchemy ? chain.rpcUrl : rpcUrl)).trim();
  const walletKey = (e.WALLET_KEY || "").trim();
  if (mode === "live" && !/^0x[0-9a-fA-F]{64}$/.test(walletKey)) {
    throw new Error("MODE=live needs WALLET_KEY (0x + 64 hex). Use a dedicated wallet, never your main one.");
  }
  const paperAddress = (e.PAPER_ADDRESS || "").trim() || (walletKey ? new ethers.Wallet(walletKey).address : ethers.ZeroAddress);
  const tgToken = (e.TG_TOKEN || "").trim();
  const tgOwnerId = (e.TG_OWNER_ID || "").trim();
  if (!tgToken) throw new Error("TG_TOKEN is required (create a bot with @BotFather)");
  if (!/^\d+:[\w-]{30,}$/.test(tgToken)) throw new Error("TG_TOKEN doesn't look like a BotFather token (digits:letters). Remove any quotes or <> around it.");
  if (!/^-?\d+$/.test(tgOwnerId)) throw new Error("TG_OWNER_ID must be your numeric Telegram id (ask @userinfobot), without quotes or <>");
  return {
    mode,
    chain,
    rpcUrl,
    logsRpcUrl,
    walletKey,
    paperAddress,
    tgToken,
    tgOwnerId,
    dataDir: path.resolve(e.DATA_DIR || "data"),
    licenseKey: (e.LICENSE_KEY || "").trim(),
    typesafeKey: (e.TYPESAFE_API_KEY || "").trim(),
    jevModel: (e.JEV_MODEL || "jev-latest").trim(),
  };
}

/** Settings only a Pro license can turn on, with how to name them to the user. */
export const PRO_SETTINGS: Partial<Record<keyof Settings, string>> = { autoEnabled: "The autopilot", autoRebalance: "Auto-rebalance", dailyReport: "The daily report" };

export class SettingsStore {
  private file: string;
  private raw: Settings;
  /** `pro` false: the Pro settings read as off and can't be switched on (the saved file keeps them) */
  constructor(
    dataDir: string,
    private readonly pro = true,
  ) {
    this.file = path.join(dataDir, "settings.json");
    this.raw = SettingsSchema.parse(readJson(this.file, {}));
  }
  get value(): Settings {
    if (this.pro) return this.raw;
    const v = { ...this.raw } as Record<string, unknown>;
    for (const k of Object.keys(PRO_SETTINGS)) v[k] = false;
    return v as Settings;
  }
  /** Set one key from a Telegram string ("20", "on", "100,500"). Returns the parsed value. */
  set(key: string, raw: string): unknown {
    const shape = SettingsSchema.shape as Record<string, z.ZodTypeAny>;
    if (!(key in shape)) throw new Error(`unknown setting "${key}". Keys: ${Object.keys(shape).join(", ")}`);
    const cur = (this.value as Record<string, unknown>)[key];
    let v: unknown;
    if (typeof cur === "boolean") v = /^(1|on|true|yes)$/i.test(raw) ? true : /^(0|off|false|no)$/i.test(raw) ? false : raw;
    else if (Array.isArray(cur)) v = raw.split(",").map((s) => Number(s.trim()));
    else if (typeof cur === "string") v = raw;
    else v = Number(raw);
    const what = PRO_SETTINGS[key as keyof Settings];
    if (!this.pro && what && v === true) throw new Error(proOnly(what));
    const next = SettingsSchema.parse({ ...this.raw, [key]: v });
    this.raw = next;
    writeJsonAtomic(this.file, next);
    return (next as Record<string, unknown>)[key];
  }
}
