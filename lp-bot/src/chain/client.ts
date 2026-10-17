/**
 * Provider + the one wallet the bot controls, and a transaction runner that:
 *   • serializes every write (no nonce races between Telegram, monitor and auto-actions)
 *   • simulates first (eth_call) so a revert is reported BEFORE any gas is spent
 *   • never waits forever on a receipt
 */
import { ethers } from "ethers";
import type { AppConfig } from "../config";
import { logger } from "../log";

const log = logger("tx");

export class Chain {
  readonly provider: ethers.JsonRpcProvider;
  /** for eth_getLogs only; the same provider unless LOGS_RPC_URL / Alchemy split them */
  readonly logsProvider: ethers.JsonRpcProvider;
  readonly signer: ethers.Wallet | null;
  readonly address: string;
  private queue: Promise<unknown> = Promise.resolve();
  /** next nonce we expect to use; sends are serialized so local tracking is safe */
  private nextNonce: number | null = null;

  constructor(readonly cfg: AppConfig) {
    const req = new ethers.FetchRequest(cfg.rpcUrl);
    req.timeout = Number(process.env.RPC_TIMEOUT_MS) || 20_000;
    // cacheTimeout -1: ethers otherwise reuses identical reads for 250ms, so a balance read right
    // after a transaction can return the pre-transaction value (sub-second blocks make that common)
    this.provider = new ethers.JsonRpcProvider(req, cfg.chain.chainId, { staticNetwork: true, cacheTimeout: -1 });
    this.provider.pollingInterval = Number(process.env.POLL_MS) || 1000;
    if (cfg.logsRpcUrl && cfg.logsRpcUrl !== cfg.rpcUrl) {
      const lr = new ethers.FetchRequest(cfg.logsRpcUrl);
      lr.timeout = req.timeout;
      this.logsProvider = new ethers.JsonRpcProvider(lr, cfg.chain.chainId, { staticNetwork: true, cacheTimeout: -1 });
    } else this.logsProvider = this.provider;
    this.signer = cfg.walletKey ? new ethers.Wallet(cfg.walletKey, this.provider) : null;
    this.address = this.signer?.address ?? cfg.paperAddress;
  }

  get contracts() {
    return this.cfg.chain.contracts;
  }

  explorerTx(hash: string): string {
    return `${this.cfg.chain.explorer}/tx/${hash}`;
  }

  /** Run `fn` with exclusive access to the wallet. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Simulate, then send and wait. Only call inside exclusive(). */
  async send(label: string, tx: ethers.TransactionRequest): Promise<ethers.TransactionReceipt> {
    if (!this.signer) throw new Error("no wallet configured (paper mode cannot send transactions)");
    const req = { ...tx, from: this.signer.address };
    let gasLimit: bigint;
    try {
      await this.provider.call(req);
      // +25%: if a trade lands first and our swap crosses more ticks, an exact estimate runs out of
      // gas inside the token transfer and reverts (surfacing as a confusing "STF")
      gasLimit = ((await this.provider.estimateGas(req)) * 125n) / 100n;
    } catch (e) {
      throw new Error(`${label}: simulation reverted, nothing sent (${shortErr(e)})`);
    }
    // providers cache eth_getTransactionCount briefly; back-to-back sends would reuse a nonce
    const chainNonce = await this.provider.getTransactionCount(this.signer.address, "pending");
    const nonce = Math.max(chainNonce, this.nextNonce ?? 0);
    let sent: ethers.TransactionResponse;
    try {
      sent = await this.signer.sendTransaction({ ...tx, nonce, gasLimit });
    } catch (e) {
      this.nextNonce = null;
      throw e;
    }
    this.nextNonce = nonce + 1;
    log.info(`${label} sent ${sent.hash}`);
    const timeoutMs = Number(process.env.TX_WAIT_MS) || 120_000;
    const rc = await sent.wait(1, timeoutMs);
    if (!rc || rc.status !== 1) throw new Error(`${label}: transaction failed (${sent.hash})`);
    return rc;
  }

  async nativeBalance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }
}

export function shortErr(e: unknown): string {
  const any = e as { shortMessage?: string; reason?: string; message?: string };
  return (any?.reason || any?.shortMessage || any?.message || String(e)).slice(0, 180);
}
