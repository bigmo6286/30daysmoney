// Local chain for integration tests. Uniswap's NonfungiblePositionManager is above the 24 KB limit.
module.exports = {
  networks: {
    hardhat: { chainId: 31337, allowUnlimitedContractSize: true, mining: { auto: true } },
  },
};
