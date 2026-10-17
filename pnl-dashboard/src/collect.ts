/**
 * Gather every source, merge bot-opened positions with their on-chain value, and report
 * anything that failed as a visible warning (never silently dropped data).
 */
import type { Row, Summary } from "./model";
import { summarize } from "./model";
import { dlmmRows, lpBotRows } from "./sources/books";
import { dlmmWalletRows, readDlmmPositions, type DlmmPos } from "./sources/dlmm";
import { readV3Positions, v3Rows, type V3Chain, type V3Position } from "./sources/univ3";
import type { DashConfig } from "./config";

export interface Readers {
  v3: (chain: V3Chain, owner: string) => Promise<V3Position[]>;
  dlmm: (rpcUrl: string, owner: string) => Promise<DlmmPos[]>;
}

const live: Readers = { v3: (c, o) => readV3Positions(c, o), dlmm: readDlmmPositions };

/** Bot rows win (they know the cost basis); a wallet row for the same position fills in value/fees/range. */
export function mergeRows(bot: Row[], wallet: Row[]): Row[] {
  const out = [...bot];
  for (const w of wallet) {
    const b = out.find((r) => r.status === "open" && !r.paper && r.chain === w.chain && r.id === w.id);
    if (!b) {
      out.push(w);
      continue;
    }
    const x = b.extra;
    const leftover = x?.leftoverRaw && w.tokenPriceNative !== undefined ? (Number(BigInt(x.leftoverRaw)) / 10 ** (x.tokenDecimals ?? 18)) * w.tokenPriceNative : 0;
    const collected = x?.collectedNative ?? 0;
    b.valueNative = w.valueNative === undefined ? undefined : w.valueNative + leftover + collected;
    b.feesNative = w.feesNative === undefined ? undefined : w.feesNative + collected;
    b.inRange = w.inRange;
    b.wallet = w.wallet;
    if (b.valueNative !== undefined && b.depositNative) {
      b.pnlNative = b.valueNative - b.depositNative;
      b.pnlPct = (b.pnlNative / b.depositNative) * 100;
    }
  }
  return out;
}

export async function collect(cfg: DashConfig, readers: Readers = live): Promise<Summary> {
  const warnings: string[] = [];
  const bot: Row[] = [];
  if (cfg.lpBot) {
    try {
      bot.push(...lpBotRows(cfg.lpBot.dataDir, cfg.chains[cfg.lpBot.chain]?.name ?? cfg.lpBot.chain));
    } catch (e) {
      warnings.push(`lp-bot book: ${(e as Error).message}`);
    }
  }
  if (cfg.dlmmDataDir) {
    try {
      bot.push(...dlmmRows(cfg.dlmmDataDir));
    } catch (e) {
      warnings.push(`dlmm-agent book: ${(e as Error).message}`);
    }
  }
  const wallet: Row[] = [];
  await Promise.all(
    cfg.wallets.map(async (w) => {
      try {
        if (w.chain === "solana") wallet.push(...dlmmWalletRows(w.address, await readers.dlmm(cfg.solanaRpc, w.address)));
        else {
          const c = cfg.chains[w.chain];
          if (!c) throw new Error(`unknown chain ${w.chain}`);
          wallet.push(...v3Rows(c, w.address, await readers.v3(c, w.address)));
        }
      } catch (e) {
        warnings.push(`${w.label ?? w.address} on ${w.chain}: ${(e as Error).message.slice(0, 200)} (positions from this wallet are missing)`);
      }
    }),
  );
  return summarize(mergeRows(bot, wallet), warnings);
}
