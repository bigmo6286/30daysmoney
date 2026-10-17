/** Chain presets, shared by the server (config.ts) and the browser dashboard (web/). No Node imports. */
import type { V3Chain } from "./sources/univ3";
import type { V4Chain } from "./sources/univ4";

/** `alchemy`: network slug used instead of the public RPC when ALCHEMY_KEY is set. */
export const V3_CHAINS: Record<string, V3Chain & { alchemy: string }> = {
  robinhood: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    alchemy: "robinhood-mainnet",
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    stables: [{ address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 }], // USDG
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    alchemy: "base-mainnet",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    weth: "0x4200000000000000000000000000000000000006",
    stables: [{ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }], // USDC
  },
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    alchemy: "arb-mainnet",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    stables: [{ address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 }], // USDC
  },
};

/** Uniswap v4 deployments read for wallets (addresses from Uniswap's sdk-core map, checked on-chain). */
export const V4_CHAINS: Record<string, V4Chain> = {
  robinhood: {
    ...V3_CHAINS.robinhood!,
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    // the public RPC allows 10M-block log ranges; the PositionManager came after block 0, so ~10 calls cover all history
    logRange: 10_000_000,
  },
};
