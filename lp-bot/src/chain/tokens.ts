import { ethers } from "ethers";
import { Token } from "@uniswap/sdk-core";
import { ERC20_ABI } from "./abis";
import type { Chain } from "./client";

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

const cache = new Map<string, TokenMeta>();

export async function tokenMeta(chain: Chain, address: string): Promise<TokenMeta> {
  const addr = ethers.getAddress(address);
  const hit = cache.get(addr);
  if (hit) return hit;
  const c = new ethers.Contract(addr, ERC20_ABI, chain.provider);
  const [symbol, decimals] = await Promise.all([
    (c.getFunction("symbol")() as Promise<string>).catch(() => "TOKEN"),
    c.getFunction("decimals")() as Promise<bigint>,
  ]);
  const meta = { address: addr, symbol: String(symbol).slice(0, 16), decimals: Number(decimals) };
  cache.set(addr, meta);
  return meta;
}

export function sdkToken(chainId: number, m: TokenMeta): Token {
  return new Token(chainId, m.address, m.decimals, m.symbol);
}

export async function erc20Balance(chain: Chain, token: string, owner: string): Promise<bigint> {
  const c = new ethers.Contract(token, ERC20_ABI, chain.provider);
  return c.getFunction("balanceOf")(owner) as Promise<bigint>;
}
