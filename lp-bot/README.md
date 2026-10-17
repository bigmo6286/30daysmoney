# LP Bot

Uniswap v3 liquidity from Telegram. Paste a token address, pick a pool, type an ETH amount, and the position is open. The bot tracks value, fees and PnL against both your deposit and plain holding, warns you when a position leaves its range, and can take profit, stop out or recentre automatically.

Runs on **Robinhood Chain** by default; **Base** and **Arbitrum** are built in, and any Uniswap v3 fork works with `CHAIN=custom`.

## Why this one

| | |
|---|---|
| 🧪 **Paper mode by default** | Reads the real pools, quotes real swaps and estimates real fees, but sends nothing. Try a strategy for a week before you put money on it. |
| 🛡 **Simulated before sent** | Every transaction is dry-run first. A revert is reported in Telegram and costs no gas. |
| ⚡ **Fewer transactions** | Single-side opens are one transaction, closes are one transaction (remove + collect + burn + unwrap to ETH). |
| 🔐 **No unlimited approvals** | Approvals are for the exact amount needed. |
| 🔒 **Owner-only** | Only your Telegram id can command the bot. Everyone else is silently ignored. |
| 💰 **Honest PnL** | Value, fees, PnL vs deposit and **vs HODL** (fees minus impermanent loss), plus fees per hour so you can spot dead positions. |
| 🤖 **Automation** | Out-of-range alerts, take-profit, stop-loss, auto-rebalance after a grace period. All off until you turn them on. |
| 🔁 **No nonce collisions** | Telegram commands and the monitor share one serialized transaction queue. |

## Open a position

1. Paste the token address.
2. Pick a pool: every WETH pool on the configured fee tiers, deepest first.
3. Type the ETH amount, e.g. `0.05`.
4. Pick a mode:
   - 🛡 **Single-side**: 100% ETH, parked just below the current price. You buy the token only if the price dips into your range. Nothing is at risk if the token rugs before then.
   - 🎯 **In-range**: ±`widthPct` around the price. The bot swaps the right share of ETH into the token first (best fee tier), then mints. Fees start immediately, but you carry token risk.
5. Confirm.

## Commands

| Command | |
|---|---|
| paste `0x…` | open a position |
| `/list` | open positions with value, fees, PnL, range, plus Close / Fees / Rebalance buttons |
| `/history` | closed positions, win rate, total PnL |
| `/close <id>` · `/collect <id>` · `/rebalance <id>` | manage one position |
| `/closeall` | close everything |
| `/wallet` | address + balance |
| `/settings` · `/set <key> <value>` | view / change settings live |

### Settings

| key | default | |
|---|---|---|
| `widthPct` | 20 | in-range width, ± % around the price (single-side: range depth below the price) |
| `singleOffsetPct` | 1 | single-side range starts this % below the price |
| `slippagePct` | 3 | slippage on swaps, mints and closes |
| `gasReserveEth` | 0.005 | ETH that opens never touch |
| `feeTiers` | 100,500,3000,10000 | fee tiers searched |
| `monitorSec` | 60 | monitor interval |
| `alertOutOfRange` | on | Telegram alert when a position leaves or re-enters its range |
| `tpPct` / `slPct` | 0 (off) | auto-close at +tp% / −sl% PnL |
| `autoRebalance` | off | close + reopen around the new price once out of range for `rebalanceGraceMin` |
| `rebalanceGraceMin` | 15 | |
| `swapToEthOnClose` | on | sell the token side back to ETH on close |

## Setup (5 minutes)

You need Node 20+ (or Docker), a Telegram bot token from [@BotFather](https://t.me/BotFather), and your numeric Telegram id from [@userinfobot](https://t.me/userinfobot).

```bash
cp .env.example .env     # fill in TG_TOKEN and TG_OWNER_ID, leave MODE=paper
npm install
npm start
```

Send `/start` to your bot. When you're ready for real funds, create a **fresh wallet** for the bot, fund it on the chain you use, set `MODE=live` and `WALLET_KEY`, and restart.

### Run 24/7 (VPS)

```bash
docker compose up -d --build
docker compose logs -f
```

State (positions, history, settings) lives in the `lpbot-data` Docker volume, or `./data` without Docker. Back it up, and never run two copies against the same wallet or Telegram token.

## Safety

- Use a dedicated wallet holding only what you're willing to lose. LP on volatile tokens can lose money, especially in-range positions on tokens that dump.
- The bot never asks for or transmits your key; it only signs locally.
- Paper fees are estimates (fee growth sampled every `monitorSec` while in range). Live fees are read from the chain.

## Development

```bash
npm run typecheck
npm test                  # unit tests (range math, PnL, formatting)
npm run test:integration  # spins up a local chain with the real Uniswap v3 contracts
```

The integration suite deploys the real Uniswap v3 factory, NonfungiblePositionManager, SwapRouter02 and QuoterV2 to a local Hardhat node, then drives the bot through open, fees, collect, close, rebalance, the paper flow, the full Telegram conversation and the monitor's alerts and stop-loss.

```
src/
├── index.ts          entrypoint
├── config.ts         .env + live-editable settings (zod)
├── chains.ts         Robinhood / Base / Arbitrum presets
├── chain/            provider, serialized tx runner, pools, tokens, ABIs
├── core/             pure math: ranges, PnL, formatting
├── lp/               LP service (live + paper), position book
├── bot/              Telegram client + conversation handlers
└── monitor.ts        alerts, TP/SL, auto-rebalance, paper fee accrual
```
