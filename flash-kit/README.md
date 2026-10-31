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
- **Not rebuilt:** RobinArb's RobinFun bonding-curve ↔ Uniswap v4 route. RobinFun publishes no contract addresses or source, and its tokens graduate into a burned LP. That suggests the curve and the pool don't trade at the same time, so this is parked until the contracts can be checked.

## Solana: Kamino flash loans + Jupiter

This rebuilds kamino-tools' "borrow → strategy → repay" without its SDK. The two klend instructions are built from the reserve account read on chain. A reserve is used only after checking that:
- klend owns it;
- it has the reserve discriminator;
- its vaults hold its mint for the market's authority PDA.

`sol-arb` borrows the loan token from Kamino's main market. It swaps into `--mid` and back through Jupiter, then repays, all in one transaction.

```bash
npm run cli -- sol-liquidity                      # 13.2M USDC available (Oct 18)
npm run cli -- sol-liquidity --token SOL
npm run cli -- sol-arb --mid <mint> --amount 1000                 # quote only
SOL_ADDRESS=<your wallet> npm run cli -- sol-arb --mid <mint>     # quote + full simulation
npm run cli -- sol-arb --mid <mint> --min-profit 0.5 --exec --yes --every 30
```

**Safety on Solana works differently from the EVM executor.** klend only checks that the loan plus its fee comes back. If the wallet already holds the loan token, a losing round trip is quietly paid from that balance.

So `--exec` refuses to run while the wallet holds any of the loan token. With an empty balance, only a route that returns the loan plus the fee can complete. Anything short fails as a whole, and you lose only the transaction fee. Profit above that is checked by simulation just before sending, not on chain.

**What mainnet showed (Oct 18, all simulated, nothing sent):**
- Kamino's flash fee on the USDC reserve is 0.001%: a 10,000 USDC borrow → repay costs exactly 0.1 USDC.
- A strategy that comes back even 1 unit short fails with "insufficient funds" at repay.
- Jupiter's cheapest USDC ↔ SOL routes often go through private market makers, such as Kipseli and TesseraV. These refuse to trade inside a transaction like this one (`NotSupport`).
  - `sol-arb` re-quotes without them.
  - The route it found (BisonFi → GoonFi V2) fit in 1,085 bytes and ~310k CU.
- A 1,000 USDC round trip through SOL quotes at about −$3, as expected on a liquid pair. Use it on long-tail tokens.

### Unattended scan (GitHub Actions)

`npm run scan` makes one pass. It borrows USDC from Kamino and round-trips it on Jupiter, at 200 and 2,000 USDC, through a batch of 8 tokens.
- The tokens are Jupiter's most-traded of the last 24 hours and the last hour.
- They must be verified, on the classic token program, with at least $200k of liquidity, and not a stablecoin or SOL. That gave 42 tokens on Oct 31.
- The batch rotates every 5 minutes, so the whole list is covered about every 30 minutes.
- If the list can't be read, the scan falls back to 8 fixed tokens.
- A `JUPITER_API_KEY` secret moves it to Jupiter's keyed endpoints, which have higher rate limits. It sends only a route whose full simulation from your wallet clears `ARB_MIN_PROFIT`, and messages the owner on Telegram for each send.

The shop workflow runs it every 5 minutes when these are set:

| repo setting | value |
|---|---|
| secret `SOL_PRIVATE_KEY` | the key of a **fresh** wallet that holds only a little SOL for fees |
| variable `SOL_ADDRESS` | that wallet's public address. The scan refuses to run if the key doesn't match. |
| variable `ARB_ENABLED` | `true` to switch it on |
| variable `ARB_MIN_PROFIT` | optional; minimum USDC profit per trade, default `0.05` |
| variable `ARB_DRY_RUN` | optional; `1` simulates and logs but never sends |
| variable `ARB_PAYOUT_ADDRESS` | optional, recommended; a **different** Solana wallet that receives all of the bot wallet's USDC after each profitable trade, and any USDC found at the start of a run. Profits never sit next to the key on the runner, and the no-USDC rule never stops the scan. The first payout creates that wallet's USDC account (~0.002 SOL rent, paid by the bot wallet). |

A pass also refuses to run when:
- the wallet holds less than 0.02 SOL;
- the wallet holds any USDC. A losing route would be paid from that balance instead of failing.

On first use, Jupiter's setup instructions create token accounts. That costs about 0.002 SOL of rent each, which you can get back by closing them.

Live check (Oct 31): all eight tokens quote fine. Every 200 USDC round trip loses $0.63–$1.68 (0.3–0.8%), so the scan idles until a real gap appears. Treat it as a lottery ticket.

## Tests

```bash
npm run typecheck && npm test
npm run test:integration    # needs ../lp-bot dependencies (local chain with the real Uniswap v3 contracts)
ALCHEMY_KEY=… npm run test:fork   # Ethereum mainnet fork: the real Morpho Blue and Uniswap v3 (or FORK_URL=…)
SOLANA_RPC_URL=… npm run test:live # Solana mainnet, simulated only: real Kamino reserves, real Jupiter routes
```

**Mainnet fork** (`test/fork`, pinned block 26,211,400): the real Morpho Blue holds >1,000 WETH, all four WETH/USDC fee tiers exist, and a scan before any trade finds nothing profitable (the market is efficient). After a 3,000 WETH dump on the 0.3% pool, the executor flash-borrows from the real Morpho, closes the gap, pays the owner exactly the simulated profit, leaves Morpho's balance unchanged and holds no tokens or allowances, and the same route then reverts. The CLI with the stock `--chain ethereum` preset does the same end to end. Read-only live checks on the same day: Morpho can lend 26.7 WETH on Robinhood Chain (confirms the address taken from the reference toolkit), 82k on Base, 13.7k on Ethereum.

On a local chain with the real Uniswap v3 factory, SwapRouter02 and QuoterV2 plus a Morpho Blue stand-in that lends exactly like Morpho (send → callback → pull back), a second pool priced 5% off creates a real gap. The tests check that the scan finds it, the simulation predicts the profit **exactly**, the transaction pays exactly that to the owner and leaves nothing behind, and every unsafe call reverts with the right error. They also run the CLI's `arb` end to end. In one run it found a gap worth less than the gas and correctly skipped it.
