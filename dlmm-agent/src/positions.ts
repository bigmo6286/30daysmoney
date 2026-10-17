/** Position book: open + closed positions, persisted atomically to data/positions.json. */
import path from "node:path";
import { readJson, writeJsonAtomic } from "./store";

export interface PositionRec {
  id: string;
  pool: string;
  /** position account (live) or a paper id */
  position: string;
  mint: string;
  symbol: string;
  solIsX: boolean;
  binStep: number;
  entryId: number;
  minBinId: number;
  maxBinId: number;
  /** bins below the entry bin, in the token-price-falling direction */
  bins: number;
  /** SOL put into liquidity */
  depositSol: number;
  /** SOL that left the wallet (deposit + rent + fees); rent comes back on close */
  spentSol: number;
  openedAt: number;
  auto: boolean;
  peakPnlPct: number;
  oor?: { state: "above" | "below"; since: number };
  /** last pool fee/TVL seen by the scanner, % */
  feeTvlPct?: number;
  paper?: { feesSol: number; at: number };
}

export interface ClosedRec extends PositionRec {
  closedAt: number;
  receivedSol: number;
  pnlSol: number;
  pnlPct: number;
  reason: string;
}

interface BookFile {
  next: number;
  open: PositionRec[];
  closed: ClosedRec[];
}

export class PositionBook {
  private file: string;
  private data: BookFile;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "positions.json");
    this.data = readJson<BookFile>(this.file, { next: 1, open: [], closed: [] });
  }
  nextId(): string {
    const id = String(this.data.next++);
    this.save();
    return id;
  }
  open(): PositionRec[] {
    return this.data.open;
  }
  closed(): ClosedRec[] {
    return this.data.closed;
  }
  get(id: string): PositionRec | undefined {
    return this.data.open.find((r) => r.id === id);
  }
  put(rec: PositionRec) {
    const i = this.data.open.findIndex((r) => r.id === rec.id);
    if (i >= 0) this.data.open[i] = rec;
    else this.data.open.push(rec);
    this.save();
  }
  close(id: string, done: Omit<ClosedRec, keyof PositionRec>): ClosedRec {
    const rec = this.get(id);
    if (!rec) throw new Error(`no open position #${id}`);
    const c: ClosedRec = { ...rec, ...done };
    this.data.open = this.data.open.filter((r) => r.id !== id);
    this.data.closed.unshift(c);
    this.data.closed = this.data.closed.slice(0, 500);
    this.save();
    return c;
  }
  save() {
    writeJsonAtomic(this.file, this.data);
  }
}
