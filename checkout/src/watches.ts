/**
 * Range alerts: the wallets each Pro buyer asked the shop bot to watch (data/watches.json).
 * The shop bot edits this list; pnl-dashboard's `alerts` script (run by the same workflow) reads
 * it, checks the positions and DMs the buyer when one leaves or re-enters its range.
 */
import path from "node:path";
import { readJson, writeJsonAtomic } from "./store";

export interface Watch {
  chatId: number;
  /** EVM address, lowercase */
  address: string;
  addedAt: number;
}

export const MAX_WATCHES = 5;

export class Watches {
  private file: string;
  private list: Watch[];
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "watches.json");
    this.list = readJson<{ watches: Watch[] }>(this.file, { watches: [] }).watches;
  }
  of(chatId: number): Watch[] {
    return this.list.filter((w) => w.chatId === chatId);
  }
  all(): Watch[] {
    return this.list;
  }
  add(chatId: number, address: string, now = Date.now()): "added" | "exists" | "full" {
    const a = address.toLowerCase();
    if (this.of(chatId).some((w) => w.address === a)) return "exists";
    if (this.of(chatId).length >= MAX_WATCHES) return "full";
    this.list.push({ chatId, address: a, addedAt: now });
    this.save();
    return "added";
  }
  remove(chatId: number, address?: string): number {
    const before = this.list.length;
    this.list = this.list.filter((w) => w.chatId !== chatId || (address !== undefined && w.address !== address.toLowerCase()));
    if (this.list.length !== before) this.save();
    return before - this.list.length;
  }
  private save() {
    writeJsonAtomic(this.file, { watches: this.list });
  }
}
