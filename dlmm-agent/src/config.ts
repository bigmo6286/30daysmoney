/**
 * Runtime configuration.
 *   .env               → secrets + RPC (never committed)
 *   data/settings.json → tunables, editable live from Telegram with /set
 */
import path from "node:path";
import { z } from "zod";
import { proOnly } from "./license";
import { readJson, writeJsonAtomic } from "./store";

export const SettingsSchema = z.object({
  // ── sizing & caps ──
  /** SOL per position. */
  sizeSol: z.number().positive().default(0.1),
  maxOpen: z.number().int().min(0).default(3),
  /** Max SOL the agent may deploy per UTC day. */
  dailySol: z.number().min(0).default(0.5),
  /** SOL never touched by opens: rent + fees for closes. */
  gasReserveSol: z.number().min(0).default(0.05),

  // ── range ──
  /** How far the price can fall (%) before the position is fully converted to the token. */
  downsidePct: z.number().min(1).max(95).default(40),
  /** Range width bounds, in bins (one position holds at most 70 bins). */
  minBins: z.number().int().min(1).default(15),
  maxBins: z.number().int().min(1).max(69).default(69),
  strategy: z.enum(["spot", "curve", "bidask"]).default("spot"),
  slippagePct: z.number().min(0.1).max(50).default(1),
  /** Priority fee, micro-lamports per compute unit. 0 = use the recent median. */
  priorityMicroLamports: z.number().int().min(0).default(0),
  swapToSolOnClose: z.boolean().default(true),

  // ── screening (Meteora pool discovery) ──
  timeframe: z.enum(["5m", "30m", "1h", "2h", "4h", "12h", "24h"]).default("4h"),
  minTvlUsd: z.number().min(0).default(10_000),
  minVolumeUsd: z.number().min(0).default(2_000),
  /** Fees earned / active TVL over `timeframe`, as reported by Meteora (%). */
  minFeeTvlPct: z.number().min(0).default(0.4),
  minMcapUsd: z.number().min(0).default(150_000),
  maxMcapUsd: z.number().min(0).default(10_000_000),
  minHolders: z.number().int().min(0).default(500),
  minOrganic: z.number().min(0).max(100).default(60),
  minBinStep: z.number().int().min(1).default(80),
  maxBinStep: z.number().int().min(1).default(125),
  /** Skip tokens younger than this. */
  minTokenAgeHours: z.number().min(0).default(2),
  /** Reject mints whose mint authority is still live (can print supply). */
  requireMintRenounced: z.boolean().default(true),
  /** Reject if the 10 largest holders (excluding the pool) own more than this %. */
  maxTop10Pct: z.number().min(0).max(100).default(50),
  /** Sell-back check: quote SOL → token → SOL through Jupiter; skip if more than this % is lost. */
  maxRoundTripLossPct: z.number().min(0).max(100).default(5),

  // ── Jev screening ──
  screen: z.boolean().default(true),
  maxCopycatPct: z.number().min(0).max(100).default(50),
  maxRugPct: z.number().min(0).max(100).default(40),
  maxRiskPct: z.number().min(0).max(100).default(60),

  // ── exits (all checked every manageSec) ──
  /** Close at −stopLossPct PnL. On by default; 0 = off. */
  stopLossPct: z.number().min(0).default(15),
  /** Close at +takeProfitPct PnL. 0 = off. */
  takeProfitPct: z.number().min(0).default(0),
  /** Trailing take-profit: arm at +trailArmPct, close after a trailDropPct drop from the peak. 0 = off. */
  trailArmPct: z.number().min(0).default(5),
  trailDropPct: z.number().min(0).default(3),
  /** No exit except the stop loss fires before this. */
  minAgeMin: z.number().min(0).default(5),
  /** Price above the range: all SOL again, earning nothing. Close after this long. */
  oorAboveMin: z.number().min(0).default(15),
  /** Price below the range: fully in the token. Close after this long. */
  oorBelowMin: z.number().min(0).default(30),
  /** Close when the pool's fee yield drops below this (after lowYieldAfterMin). 0 = off. */
  minFeeTvlPctHold: z.number().min(0).default(0.05),
  lowYieldAfterMin: z.number().min(0).default(60),
  /** Re-entry cooldown on a pool/token after closing it. */
  cooldownHours: z.number().min(0).default(6),

  // ── loop ──
  /** Master switch for auto-opening. Exits on open positions run regardless. */
  autoEnabled: z.boolean().default(false),
  scanMin: z.number().min(1).default(15),
  manageSec: z.number().int().min(10).default(30),
  dailyReport: z.boolean().default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

export type Mode = "paper" | "live";

export interface AppConfig {
  mode: Mode;
  rpcUrl: string;
  walletKey: string;
  /** paper mode can watch any address */
  paperAddress: string;
  tgToken: string;
  tgOwnerId: string;
  dataDir: string;
  jupiterKey: string;
  /** Pro license from checkout; empty = free tier */
  licenseKey: string;
  typesafeKey: string;
  jevModel: string;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode: Mode = (e.MODE || "paper").toLowerCase() === "live" ? "live" : "paper";
  const alchemyKey = (e.ALCHEMY_KEY || "").trim();
  const rpcUrl = (e.RPC_URL || (alchemyKey ? `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}` : "https://api.mainnet-beta.solana.com")).trim();
  const walletKey = (e.WALLET_KEY || "").trim();
  if (mode === "live" && !walletKey) {
    throw new Error("MODE=live needs WALLET_KEY (base58 secret key or a JSON byte array). Use a dedicated wallet, never your main one.");
  }
  const tgToken = (e.TG_TOKEN || "").trim();
  const tgOwnerId = (e.TG_OWNER_ID || "").trim();
  if (!tgToken) throw new Error("TG_TOKEN is required (create a bot with @BotFather)");
  if (!/^\d+:[\w-]{30,}$/.test(tgToken)) throw new Error("TG_TOKEN doesn't look like a BotFather token (digits:letters). Remove any quotes or <> around it.");
  if (!/^-?\d+$/.test(tgOwnerId)) throw new Error("TG_OWNER_ID must be your numeric Telegram id (ask @userinfobot), without quotes or <>");
  return {
    mode,
    rpcUrl,
    walletKey,
    paperAddress: (e.PAPER_ADDRESS || "").trim(),
    tgToken,
    tgOwnerId,
    dataDir: path.resolve(e.DATA_DIR || "data"),
    jupiterKey: (e.JUPITER_API_KEY || "").trim(),
    licenseKey: (e.LICENSE_KEY || "").trim(),
    typesafeKey: (e.TYPESAFE_API_KEY || "").trim(),
    jevModel: (e.JEV_MODEL || "jev-latest").trim(),
  };
}

/** Settings only a Pro license can turn on, with how to name them to the user. */
export const PRO_SETTINGS: Partial<Record<keyof Settings, string>> = { autoEnabled: "The autopilot", dailyReport: "The daily report" };

/**
 * Strategy presets: a bundle of range, screening and exit settings, so a new user picks a risk
 * level instead of tuning 20 numbers. They never touch sizing (how much SOL is yours to decide),
 * the Pro switches, or the safety floors: every preset keeps the stop loss on, mint authority
 * renounced, and the Jev rug threshold at or below the default.
 */
export type PresetName = "safe" | "balanced" | "aggressive";
type PresetKey =
  | "downsidePct" | "strategy" | "timeframe" | "minTvlUsd" | "minVolumeUsd" | "minFeeTvlPct" | "minMcapUsd" | "minHolders" | "minOrganic"
  | "minTokenAgeHours" | "maxTop10Pct" | "maxRoundTripLossPct" | "maxRugPct" | "maxRiskPct" | "stopLossPct" | "trailArmPct" | "trailDropPct"
  | "oorAboveMin" | "oorBelowMin" | "minFeeTvlPctHold" | "cooldownHours";
const DEFAULTS = SettingsSchema.parse({});
const pick = (s: Settings, keys: PresetKey[]) => Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<Settings, PresetKey>;
const PRESET_KEYS: PresetKey[] = ["downsidePct", "strategy", "timeframe", "minTvlUsd", "minVolumeUsd", "minFeeTvlPct", "minMcapUsd", "minHolders", "minOrganic", "minTokenAgeHours", "maxTop10Pct", "maxRoundTripLossPct", "maxRugPct", "maxRiskPct", "stopLossPct", "trailArmPct", "trailDropPct", "oorAboveMin", "oorBelowMin", "minFeeTvlPctHold", "cooldownHours"];

export const PRESETS: Record<PresetName, { blurb: string; values: Pick<Settings, PresetKey> }> = {
  safe: {
    blurb: "older, bigger, widely held tokens; tighter stop loss; slower in and out",
    values: {
      ...pick(DEFAULTS, PRESET_KEYS),
      downsidePct: 30, timeframe: "12h", minTvlUsd: 50_000, minVolumeUsd: 10_000, minFeeTvlPct: 0.3, minMcapUsd: 1_000_000, minHolders: 2_000,
      minOrganic: 75, minTokenAgeHours: 24, maxTop10Pct: 35, maxRoundTripLossPct: 3, maxRugPct: 25, maxRiskPct: 40,
      stopLossPct: 10, trailArmPct: 4, trailDropPct: 2, oorBelowMin: 15, cooldownHours: 12,
    },
  },
  balanced: { blurb: "the defaults", values: pick(DEFAULTS, PRESET_KEYS) },
  aggressive: {
    blurb: "young, small, high-fee pools; wider range and stop loss; more opens, more losses",
    values: {
      ...pick(DEFAULTS, PRESET_KEYS),
      downsidePct: 60, timeframe: "1h", minTvlUsd: 5_000, minVolumeUsd: 1_000, minFeeTvlPct: 0.8, minMcapUsd: 75_000, minHolders: 250,
      minOrganic: 50, minTokenAgeHours: 0.5, maxTop10Pct: 60, maxRoundTripLossPct: 8, stopLossPct: 25, trailArmPct: 8, trailDropPct: 4,
      oorAboveMin: 10, oorBelowMin: 45, cooldownHours: 3,
    },
  },
};

/** The preset the current settings match exactly, if any. */
export function presetOf(s: Settings): PresetName | null {
  for (const [name, p] of Object.entries(PRESETS) as [PresetName, (typeof PRESETS)[PresetName]][]) {
    if (PRESET_KEYS.every((k) => s[k] === p.values[k])) return name;
  }
  return null;
}

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
  /** Set one key from a Telegram string ("20", "on", "4h"). Returns the parsed value. */
  set(key: string, raw: string): unknown {
    const shape = SettingsSchema.shape as Record<string, z.ZodTypeAny>;
    if (!(key in shape)) throw new Error(`unknown setting "${key}". Keys: ${Object.keys(shape).join(", ")}`);
    const cur = (this.value as Record<string, unknown>)[key];
    let v: unknown;
    if (typeof cur === "boolean") v = /^(1|on|true|yes)$/i.test(raw) ? true : /^(0|off|false|no)$/i.test(raw) ? false : raw;
    else if (typeof cur === "string") v = raw;
    else v = Number(raw);
    const what = PRO_SETTINGS[key as keyof Settings];
    if (!this.pro && what && v === true) throw new Error(proOnly(what));
    const next = SettingsSchema.parse({ ...this.raw, [key]: v });
    this.raw = next;
    writeJsonAtomic(this.file, next);
    return (next as Record<string, unknown>)[key];
  }

  /** Apply a preset. Returns the keys that changed, with old → new. */
  applyPreset(name: string): { key: string; from: unknown; to: unknown }[] {
    const p = PRESETS[name as PresetName];
    if (!p) throw new Error(`unknown preset "${name}". Presets: ${Object.keys(PRESETS).join(", ")}`);
    const changed = PRESET_KEYS.filter((k) => this.raw[k] !== p.values[k]).map((k) => ({ key: k, from: this.raw[k], to: p.values[k] }));
    this.raw = SettingsSchema.parse({ ...this.raw, ...p.values });
    writeJsonAtomic(this.file, this.raw);
    return changed;
  }
}
