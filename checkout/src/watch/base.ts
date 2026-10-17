/** Incoming USDC on Base: ERC-20 Transfer logs to the receiver, a few blocks behind the head. */
import type { Transfer } from "../orders";
import { rpc } from "./rpc";

export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CONFIRMATIONS = 3;
const CHUNK = 2_000;

interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

const topicAddr = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

export function parseLog(l: Log): { txid: string; amountMicro: number; from: string; block: number } | null {
  if (l.removed || l.address.toLowerCase() !== BASE_USDC || l.topics[0] !== TRANSFER || l.topics.length < 3) return null;
  return {
    // one tx can carry several transfers: key by log index too
    txid: `${l.transactionHash}:${parseInt(l.logIndex, 16)}`,
    amountMicro: Number(BigInt(l.data)),
    from: "0x" + l.topics[1]!.slice(26),
    block: parseInt(l.blockNumber, 16),
  };
}

export class BaseWatcher {
  private next: number | undefined;
  constructor(
    private readonly rpcUrl: string,
    private readonly receiver: string,
    state: { next?: number },
    private readonly f: typeof fetch = fetch,
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(receiver)) throw new Error("BASE_RECEIVER must be a 0x address");
    this.next = state.next;
  }

  get state() {
    return { next: this.next };
  }

  async poll(): Promise<Transfer[]> {
    const head = parseInt(await rpc<string>(this.rpcUrl, "eth_blockNumber", [], this.f), 16) - CONFIRMATIONS;
    let from = this.next ?? head - 300; // first run: look back ~10 minutes
    const out: Transfer[] = [];
    const times = new Map<number, number>();
    while (from <= head) {
      const to = Math.min(head, from + CHUNK - 1);
      const logs = await rpc<Log[]>(
        this.rpcUrl,
        "eth_getLogs",
        [{ address: BASE_USDC, topics: [TRANSFER, null, topicAddr(this.receiver)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }],
        this.f,
      );
      for (const l of logs) {
        const p = parseLog(l);
        if (!p) continue;
        if (!times.has(p.block)) {
          const b = await rpc<{ timestamp: string }>(this.rpcUrl, "eth_getBlockByNumber", ["0x" + p.block.toString(16), false], this.f);
          times.set(p.block, parseInt(b.timestamp, 16) * 1000);
        }
        out.push({ chain: "base", txid: p.txid, amountMicro: p.amountMicro, from: p.from, at: times.get(p.block)! });
      }
      from = to + 1;
    }
    this.next = from;
    return out;
  }
}
