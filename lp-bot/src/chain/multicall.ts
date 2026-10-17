/** Batch read-only calls through Multicall3 when the chain has it; plain parallel calls otherwise. */
import { ethers } from "ethers";
import type { Chain } from "./client";

const MULTICALL3 = process.env.MULTICALL3 || "0xcA11bde05977b3631167028862bE2a173976CA11";
const iface = new ethers.Interface([
  "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])",
]);
const BATCH = 150;

export interface Call {
  target: string;
  data: string;
}

let available: boolean | undefined;

/** Returns raw return data per call, or null where the call reverted. */
export async function multicall(chain: Chain, calls: Call[]): Promise<(string | null)[]> {
  if (available === undefined) available = (await chain.provider.getCode(MULTICALL3)).length > 2;
  if (!available) {
    return Promise.all(calls.map((c) => chain.provider.call({ to: c.target, data: c.data }).catch(() => null)));
  }
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH);
    const data = iface.encodeFunctionData("aggregate3", [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
    const ret = await chain.provider.call({ to: MULTICALL3, data });
    const [results] = iface.decodeFunctionResult("aggregate3", ret);
    for (const r of results as { success: boolean; returnData: string }[]) out.push(r.success ? r.returnData : null);
  }
  return out;
}
