/**
 * Observable facts about a token contract, gathered from the chain. Code collects facts;
 * a screener (e.g. Jev) judges what they mean. Nothing here decides on its own.
 */
import { ethers } from "ethers";
import { isPoolId } from "../chain/v4";
import type { Chain } from "../chain/client";

/** Admin functions that let a deployer take value from holders after launch. */
const RISKY_FUNCTIONS = [
  "mint(address,uint256)",
  "blacklist(address)",
  "addToBlacklist(address)",
  "setBlacklist(address,bool)",
  "blacklistAddress(address,bool)",
  "setTax(uint256)",
  "setFee(uint256)",
  "setFees(uint256,uint256)",
  "setBuyTax(uint256)",
  "setSellTax(uint256)",
  "updateFees(uint256,uint256)",
  "setMaxTxAmount(uint256)",
  "setMaxWalletSize(uint256)",
  "setTradingEnabled(bool)",
  "enableTrading()",
  "openTrading()",
  "pause()",
  "excludeFromFee(address)",
];
const SELECTORS = RISKY_FUNCTIONS.map((sig) => ({ sig, push4: "63" + ethers.id(sig).slice(2, 10) }));
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const DEAD = new Set([ethers.ZeroAddress.toLowerCase(), "0x000000000000000000000000000000000000dead"]);

export interface TokenFacts {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  /** share of total supply sitting in the pool being considered, % */
  supplyInPoolPct: number;
  /** "renounced" | "none" (no owner()) | the owner address */
  owner: string;
  upgradeableProxy: boolean;
  codeSizeBytes: number;
  /** admin functions found in the contract's dispatch table */
  adminFunctions: string[];
}

const call = async <T>(c: ethers.Contract, fn: string, ...args: unknown[]): Promise<T | null> => {
  try {
    return (await c.getFunction(fn)(...args)) as T;
  } catch {
    return null;
  }
};

export async function tokenFacts(chain: Chain, token: string, pool: string): Promise<TokenFacts> {
  // a v4 pool holds no balance of its own: the PoolManager holds every v4 pool's tokens
  if (isPoolId(pool)) pool = chain.cfg.chain.v4?.poolManager ?? ethers.ZeroAddress;
  const c = new ethers.Contract(
    token,
    [
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)",
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
      "function owner() view returns (address)",
    ],
    chain.provider,
  );
  const [name, symbol, decimals, supply, inPool, owner, code, impl] = await Promise.all([
    call<string>(c, "name"),
    call<string>(c, "symbol"),
    call<bigint>(c, "decimals"),
    call<bigint>(c, "totalSupply"),
    call<bigint>(c, "balanceOf", pool),
    call<string>(c, "owner"),
    chain.provider.getCode(token),
    chain.provider.getStorage(token, EIP1967_IMPL_SLOT).catch(() => ethers.ZeroHash),
  ]);
  const hex = code.toLowerCase();
  return {
    address: ethers.getAddress(token),
    name: String(name ?? "").slice(0, 64),
    symbol: String(symbol ?? "").slice(0, 24),
    decimals: Number(decimals ?? 18),
    totalSupply: String(supply ?? 0n),
    supplyInPoolPct: supply && inPool !== null && supply > 0n ? Number((inPool * 10_000n) / supply) / 100 : 0,
    owner: owner === null ? "none" : DEAD.has(owner.toLowerCase()) ? "renounced" : owner,
    upgradeableProxy: BigInt(impl) !== 0n,
    codeSizeBytes: Math.max(0, (code.length - 2) / 2),
    adminFunctions: SELECTORS.filter((s) => hex.includes(s.push4)).map((s) => s.sig),
  };
}
