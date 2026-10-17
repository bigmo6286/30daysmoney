import { NativeCurrency, Token, type Currency } from "@uniswap/sdk-core";

/** Native ETH for any chain id (the SDK's Ether class only knows a fixed list of chains). */
export class Native extends NativeCurrency {
  constructor(private readonly weth: Token) {
    super(weth.chainId, 18, "ETH", "Ether");
  }
  get wrapped(): Token {
    return this.weth;
  }
  equals(other: Currency): boolean {
    return other.isNative && other.chainId === this.chainId;
  }
}
