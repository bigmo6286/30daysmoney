# 30daysmoney

Tools for liquidity providers, all open source. **[Store](https://bigmo6286.github.io/30daysmoney/?ref=github)** · **[Free LP dashboard](https://bigmo6286.github.io/30daysmoney/dashboard/?ref=github)**

| | what | free | Pro |
|---|---|---|---|
| [`lp-bot/`](lp-bot/) | Telegram LP bot: Uniswap v3 + v4 on Robinhood Chain, Base, Arbitrum | manual LP, paper mode, alerts, stop loss | autopilot, auto-rebalance, daily report |
| [`dlmm-agent/`](dlmm-agent/) | Telegram agent for Meteora DLMM on Solana | manual LP, paper mode, presets, stop loss | autopilot, daily report |
| [`pnl-dashboard/`](pnl-dashboard/) | every LP position across wallets, in the browser | 1 wallet, share card | 20 wallets, history, CSV, Telegram range alerts |
| [`flash-kit/`](flash-kit/) | flash-loan arbitrage: Morpho + Uniswap (EVM), Kamino + Jupiter (Solana) | all of it | – |
| [`checkout/`](checkout/) | USDC checkout over Telegram with no server (Base + Solana) | all of it | – |

Every bot starts in paper mode, simulates each transaction before sending, and runs on your machine with your keys.

## About this repo

Goal: **$2,000 in revenue in 30 days**, built on top of open-source repos from [FlipZ3ro](https://github.com/FlipZ3ro).

Start: 2026-10-17 · Deadline: 2026-11-16

## Rules
1. FlipZ3ro's repos are **reference material**. We study what they do and write our own, improved implementations in this repo.
2. Revenue = money actually received. Paper PnL and airdrop speculation don't count.
3. Never custody customer funds or keys. Sell software, hosting, setup and support, not investment returns.
4. Log every dollar in [`LEDGER.md`](LEDGER.md).

See [`PLAN.md`](PLAN.md) for the strategy.
