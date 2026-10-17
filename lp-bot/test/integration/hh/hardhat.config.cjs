// Local chain for integration tests. Uniswap's NonfungiblePositionManager is above the 24 KB limit.
// HH_CHAIN_ID lets flash-kit's mainnet-fork tests (`node --fork …`) keep the forked chain's id.
module.exports = {
  networks: {
    hardhat: { chainId: Number(process.env.HH_CHAIN_ID || 31337), allowUnlimitedContractSize: true, mining: { auto: true } },
  },
};
