/** v4 SDK objects for a native-ETH pool view, plus the Permit2 approval path the v4 contracts pull through. */
import { ethers } from "ethers";
import { Pool as V4Pool, Position as V4Position } from "@uniswap/v4-sdk";
import type { Chain } from "../chain/client";
import type { PoolView } from "../chain/pools";
import { sdkToken } from "../chain/tokens";
import { PERMIT2_ABI, v4Of } from "../chain/v4";
import { ERC20_ABI } from "../chain/abis";
import { Native } from "./native";

export function v4SdkPool(chain: Chain, v: PoolView): { pool: V4Pool; native: Native } {
  if (v.version !== 4 || !v.v4Key) throw new Error("not a v4 pool");
  const chainId = chain.cfg.chain.chainId;
  const native = new Native(sdkToken(chainId, { address: chain.contracts.weth, symbol: "WETH", decimals: 18 }));
  const k = v.v4Key;
  const pool = new V4Pool(native, sdkToken(chainId, v.token), k.fee, k.tickSpacing, k.hooks, v.sqrtPriceX96.toString(), v.liquidity.toString(), v.tick);
  return { pool, native };
}

export function v4Position(pool: V4Pool, liquidity: bigint, tickLower: number, tickUpper: number): V4Position {
  return new V4Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });
}

/**
 * Exact approvals for a v4 spender: token → Permit2 for `amount`, then Permit2 → spender for
 * `amount` expiring in an hour. Nothing unlimited is left behind. Call inside exclusive().
 */
export async function ensurePermit2(chain: Chain, token: string, spender: string, amount: bigint, txs: { label: string; hash: string }[]) {
  const permit2 = v4Of(chain).permit2;
  const erc = new ethers.Contract(token, ERC20_ABI, chain.provider);
  if (((await erc.getFunction("allowance")(chain.address, permit2)) as bigint) < amount) {
    const rc = await chain.send("approve Permit2", { to: token, data: erc.interface.encodeFunctionData("approve", [permit2, amount]) });
    txs.push({ label: "approve", hash: rc.hash });
  }
  const p2 = new ethers.Contract(permit2, PERMIT2_ABI, chain.provider);
  const [allowed, expiration] = (await p2.getFunction("allowance")(chain.address, token, spender)) as [bigint, bigint];
  const now = Math.floor(Date.now() / 1000);
  if (allowed < amount || Number(expiration) < now + 300) {
    const rc = await chain.send("Permit2 allowance", { to: permit2, data: p2.interface.encodeFunctionData("approve", [token, spender, amount, now + 3600]) });
    txs.push({ label: "permit2", hash: rc.hash });
  }
}
