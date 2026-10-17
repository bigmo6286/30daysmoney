// Local chain for integration tests. Uniswap's NonfungiblePositionManager is above the 24 KB limit.
// HH_CHAIN_ID lets mainnet-fork tests (`node --fork …`) keep the forked chain's id. Forked chains
// Hardhat doesn't know need their EVM rules spelled out: Robinhood Chain is Cancun-level, which
// Uniswap v4's transient storage needs.
module.exports = {
  networks: {
    hardhat: {
      chainId: Number(process.env.HH_CHAIN_ID || 31337),
      hardfork: "cancun",
      allowUnlimitedContractSize: true,
      mining: { auto: true },
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
    },
  },
};
