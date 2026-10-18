/** The Solana half of the browser dashboard, in its own chunk (loaded only for Solana wallets). */
import { dlmmWalletRows, readDlmmPositions } from "../src/sources/dlmm";
import type { Row } from "../src/model";

export async function dlmmRows(rpcUrl: string, owner: string): Promise<Row[]> {
  return dlmmWalletRows(owner, await readDlmmPositions(rpcUrl, owner));
}
