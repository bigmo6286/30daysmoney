/** Persistent book of positions the bot opened (live NFTs and paper positions) + closed history. */
import path from "node:path";
import { readJson, writeJsonAtomic } from "../store";
import type { RangeMode } from "../core/range";

export interface PositionRecord {
  id: string; // live: NFT tokenId · paper: "P<n>"
  kind: "live" | "paper";
  pool: string;
  token: string;
  symbol: string;
  tokenDecimals: number;
  quoteIsToken0: boolean;
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  mode: RangeMode;
  widthPct: number;
  liquidity: string;
  /** total ETH (wei) committed, including the part swapped into the token */
  depositQuote: string;
  /** amounts that actually entered the position */
  depositToken: string;
  depositQuoteInPosition: string;
  /** token bought for the position that didn't fit the range; sits in the wallet, swept on close */
  leftoverToken?: string;
  /** fees already collected, valued in ETH at collection time */
  collectedQuote: string;
  openedAt: number;
  /** paper only: accrued fee estimate + last fee-growth snapshot */
  paperFee0?: string;
  paperFee1?: string;
  growth0?: string;
  growth1?: string;
  paperInRange?: boolean;
  /** monitor bookkeeping */
  inRange?: boolean;
  outOfRangeSince?: number;
}

export interface ClosedRecord {
  id: string;
  kind: "live" | "paper";
  symbol: string;
  fee: number;
  mode: RangeMode;
  openedAt: number;
  closedAt: number;
  depositQuote: string;
  realizedQuote: string;
  feesQuote: string;
  pnlQuote: string;
  pnlPct: number;
  reason: string;
}

interface BookFile {
  open: Record<string, PositionRecord>;
  closed: ClosedRecord[];
  nextPaperId: number;
}

export class PositionBook {
  private file: string;
  private data: BookFile;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "positions.json");
    this.data = readJson<BookFile>(this.file, { open: {}, closed: [], nextPaperId: 1 });
  }
  private save() {
    writeJsonAtomic(this.file, this.data);
  }
  nextPaperId(): string {
    const id = `P${this.data.nextPaperId++}`;
    this.save();
    return id;
  }
  open(): PositionRecord[] {
    return Object.values(this.data.open).sort((a, b) => a.openedAt - b.openedAt);
  }
  get(id: string): PositionRecord | undefined {
    return this.data.open[id];
  }
  put(rec: PositionRecord) {
    this.data.open[rec.id] = rec;
    this.save();
  }
  close(id: string, closed: ClosedRecord) {
    delete this.data.open[id];
    this.data.closed.unshift(closed);
    this.save();
  }
  closed(): ClosedRecord[] {
    return this.data.closed;
  }
}
