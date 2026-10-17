/**
 * Uniswap v3 deployments the bot knows out of the box. Any field can be overridden from .env,
 * and CHAIN=custom lets you point the bot at any other v3 fork.
 */
export interface ChainPreset {
  name: string;
  chainId: number;
  rpcUrl: string;
  /** Alchemy network slug: with ALCHEMY_KEY set, the bot uses Alchemy instead of the public RPC */
  alchemy?: string;
  explorer: string;
  nativeSymbol: string;
  contracts: {
    factory: string;
    positionManager: string;
    swapRouter02: string;
    quoterV2: string;
    weth: string;
  };
}

export const CHAINS: Record<string, ChainPreset> = {
  robinhood: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    alchemy: "robinhood-mainnet",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
    contracts: {
      factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
      positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
      swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
      quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
      weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    },
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    alchemy: "base-mainnet",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
    contracts: {
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
      swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      weth: "0x4200000000000000000000000000000000000006",
    },
  },
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    alchemy: "arb-mainnet",
    explorer: "https://arbiscan.io",
    nativeSymbol: "ETH",
    contracts: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    },
  },
};
