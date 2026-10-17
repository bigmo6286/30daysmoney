/**
 * Any wallet's Meteora DLMM positions (SOL pairs), via the official SDK: token amounts +
 * unclaimed fees, valued in SOL at the pool's active-bin price.
 */
import { createRequire } from "node:module";
import type DLMMClass from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Row } from "../model";

// the SDK's ESM build fails under Node ("Directory import ... is not supported"); its CJS build works
const DLMM = createRequire(import.meta.url)("@meteora-ag/dlmm") as typeof DLMMClass;
const WSOL = "So11111111111111111111111111111111111111112";

/** Price of token X in token Y (UI units) at a bin. */
export function binPrice(activeId: number, binStep: number, decX: number, decY: number): number {
  return Math.pow(1 + binStep / 10_000, activeId) * Math.pow(10, decX - decY);
}

export interface DlmmPos {
  position: string;
  pool: string;
  solIsX: boolean;
  symbol: string;
  /** token amounts in UI units */
  solAmt: number;
  tokAmt: number;
  solFee: number;
  tokFee: number;
  /** token price in SOL */
  tokenPriceSol: number;
  inRange: boolean;
}

export function dlmmValue(p: DlmmPos) {
  const fees = p.solFee + p.tokFee * p.tokenPriceSol;
  return { value: p.solAmt + p.tokAmt * p.tokenPriceSol + fees, fees };
}

export async function readDlmmPositions(rpcUrl: string, owner: string): Promise<DlmmPos[]> {
  const conn = new Connection(rpcUrl, "confirmed");
  const all = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(owner));
  const out: DlmmPos[] = [];
  for (const [pool, info] of all) {
    const x = info.tokenX;
    const y = info.tokenY;
    const solIsX = x.publicKey.toBase58() === WSOL;
    if (!solIsX && y.publicKey.toBase58() !== WSOL) continue; // SOL pairs only
    const decX = x.mint.decimals;
    const decY = y.mint.decimals;
    const pxy = binPrice(info.lbPair.activeId, info.lbPair.binStep, decX, decY);
    const tok = solIsX ? y : x;
    for (const pos of info.lbPairPositionsData) {
      const d = pos.positionData;
      const ux = (v: { toString(): string }) => Number(v.toString()) / 10 ** decX;
      const uy = (v: { toString(): string }) => Number(v.toString()) / 10 ** decY;
      const [xAmt, yAmt, xFee, yFee] = [ux(d.totalXAmount), uy(d.totalYAmount), ux(d.feeX), uy(d.feeY)];
      out.push({
        position: pos.publicKey.toBase58(),
        pool,
        solIsX,
        symbol: tok.publicKey.toBase58().slice(0, 4) + "…",
        solAmt: solIsX ? xAmt : yAmt,
        tokAmt: solIsX ? yAmt : xAmt,
        solFee: solIsX ? xFee : yFee,
        tokFee: solIsX ? yFee : xFee,
        tokenPriceSol: solIsX ? 1 / pxy : pxy,
        inRange: info.lbPair.activeId >= d.lowerBinId && info.lbPair.activeId <= d.upperBinId,
      });
    }
  }
  return out;
}

export function dlmmWalletRows(owner: string, positions: DlmmPos[]): Row[] {
  return positions.map((p) => {
    const { value, fees } = dlmmValue(p);
    return { source: "wallet", chain: "solana", wallet: owner, id: p.position, pair: `${p.symbol}/SOL`, status: "open", unit: "SOL", valueNative: value, feesNative: fees, inRange: p.inRange } satisfies Row;
  });
}
