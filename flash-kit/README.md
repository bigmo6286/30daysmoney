# flash-kit

Flash-loan arbitrage for EVM chains, with the safety on-chain. Borrow from **Morpho Blue** (no fee), buy a token on one Uniswap v3 pool, sell it on another, repay, and **revert unless the profit clears your floor**. One CLI: liquidity → quote → scan → simulate → execute.

Rebuilt from FlipZ3ro's RobinArb, rh-flash-toolkit, morpho-toolkit and kamino-tools. What we kept and what we fixed:

| reference | problem | here |
|---|---|---|
| rh-flash-toolkit `FlashSwap` / `FlashToolkit` | **anyone can drain them**: the callback trusts a caller-supplied pair and an argument it thinks is `msg.sender` | the callback runs only for Morpho, only during our own call, only for the exact route we started (hash-bound) |
| morpho-toolkit / rh-flash-toolkit flash loans | borrow and repay with no strategy: pure gas burn | a real two-leg route with profit-or-revert |
| RobinArb EOA mode | two transactions, max approvals, can unwind at a loss | atomic only; exact approvals reset to 0 |
| RobinArb gas | fixed 700k units | gas from simulation × the live gas price, added to the on-chain profit floor |
| all | no simulation, or a typed "YES" as the only gate | every route is simulated (`eth_call` from the owner) first; sends need `--yes` |

The best idea in the references, morpho-toolkit's `MorphoAtomicArbPOC` (allowlisted routers, hash-bound route, exact approvals), is the base of `contracts/FlashArb.sol`.

## The executor (`contracts/FlashArb.sol`)

- `execute(route)`: owner only. Flash-borrows `amount` of `loanToken` from Morpho, swaps it into `midToken` on `buyRouter`/`buyFee` (min `minMidOut`), swaps everything back on `sellRouter`/`sellFee` (must at least repay), repays, and **reverts with `NoProfit` unless the balance grew by `minProfit`**. The profit goes to the owner in the same transaction.
- Guards: `NotOwner`, `NotMorpho`, `NoActiveRoute` (callback outside our own call or for a different route), `RouterNotAllowed`, `Expired` (route deadline), `Busy` (reentry).
- Nothing stays in the contract: no mid token, no allowances, no loan token.
- `setRouter`, `rescue` (owner only).
- `artifacts/FlashArb.json` is committed; a test fails if it ever differs from what the source compiles to (`npm run compile` regenerates it).

## Use

```bash
cp .env.example .env            # PRIVATE_KEY of a dedicated wallet
npm install
npm run cli -- chains
npm run cli -- liquidity --chain base                        # how much WETH Morpho can lend
npm run cli -- scan  --chain base --mid 0xTOKEN --min 0.1 --max 10
npm run cli -- deploy --chain base                           # prints the plan
npm run cli -- deploy --chain base --yes
npm run cli -- arb --chain base --executor 0xEXEC --mid 0xTOKEN --min-profit 0.001          # dry run
npm run cli -- arb --chain base --executor 0xEXEC --mid 0xTOKEN --min-profit 0.001 --exec --yes --every 30
```

`arb` scans every pair of fee tiers and sizes (doubling from `--min` to `--max`, capped by Morpho's liquidity), simulates the best route to get its gas, and only sends when the simulated profit ≥ `--min-profit` + gas; that floor is enforced on-chain too, so if the price moves before your transaction lands, it reverts instead of losing money (you still pay gas for the revert).

Chains: Robinhood Chain, Base, Ethereum, or any chain with Morpho Blue + Uniswap v3 via `--chain custom`.

## Honest limits

- Most two-pool gaps on liquid pairs are closed by others within a block. This is a tool, not a money printer: run it on long-tail pairs, and expect most scans to report nothing.
- Public mempools: a visible profitable transaction can be copied or sandwiched. The revert floor protects your principal, not your gas. Use a private RPC where your chain has one.
- **Not rebuilt yet:** kamino-tools' Solana flash borrow→strategy→repay builder, and RobinArb's RobinFun bonding-curve ↔ Uniswap v4 route. Both need live RPC access to test, which this build environment doesn't have.

## Tests

```bash
npm run typecheck && npm test
npm run test:integration    # needs ../lp-bot dependencies (local chain with the real Uniswap v3 contracts)
```

On a local chain with the real Uniswap v3 factory, SwapRouter02 and QuoterV2 plus a Morpho Blue stand-in that lends exactly like Morpho (send → callback → pull back), a second pool priced 5% off creates a real gap. The tests check that the scan finds it, the simulation predicts the profit **exactly**, the transaction pays exactly that to the owner and leaves nothing behind, and every unsafe call reverts with the right error. They also run the CLI's `arb` end to end. In one run it found a gap worth less than the gas and correctly skipped it.
