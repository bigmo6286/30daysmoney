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

## Uniswap v4

On Robinhood Chain the bot also LPs in **Uniswap v4** pools. v4 has more trading there than v3. Paste a token and the pool picker lists v3 and v4 pools side by side; open, `/list`, collect, close, rebalance, the monitor and paper mode all work the same.

- **Native-ETH pools without hooks only.** ETH is the bot's quote currency. A hook is arbitrary code that runs on every swap and liquidity change, so hooked pools are refused, even when pasted by pool id.
- **Pools the V4Quoter can't price are skipped.** Some live pools revert `NotEnoughLiquidity` both ways, and a pool you can't price a sell on is one you might not get out of.
- **How it trades:** swaps go through the UniversalRouter, positions through the v4 PositionManager. Both pull tokens via Permit2 with **exact** amounts that expire in an hour; nothing unlimited is left approved. Fees are read from StateView (fee growth inside the range minus the position's last snapshot).
- **The autopilot covers v4 too.** The scanner reads v3 and v4 Swap logs in one query, finds v4 pool keys through the PositionManager, keeps the same hookless native-ETH subset, and prices a position's yield from StateView fee growth exactly as for v3. `/scan` marks v4 pools. Only the configured fee tiers count (v4 also has 0%-fee pools, where an LP earns nothing). A v4 pool holds no balance of its own, so its "depth" is the ETH it would take to push the price 10% at the current liquidity.

Tested against the real v4 contracts on a Robinhood Chain fork (`ALCHEMY_KEY=… npx vitest run test/integration/v4fork.test.ts`, pinned block 90,849,900):
- the pool is found from a pasted token, and a pasted pool id resolves; a hooked pool is refused;
- live in-range open: swap via the router, mint via the PositionManager, the NFT is owned by the bot, unused ETH comes back;
- another wallet's trades earn fees, and `collect` pays exactly the fees computed from StateView, to the wei;
- close burns the NFT and sells the token back into the same pool, leaving no token behind;
- single-sided open and close;
- paper mode on the same pool sends nothing;
- the autopilot scanner indexes live v4 pools (hookless only), measures yield across two scans with a real trade in between, and runs the buy→sell round-trip check in the same pool.

## Free and Pro

Free: everything you drive yourself, plus paper mode, range alerts, stop loss and take profit (safety is never paywalled). **Pro** (a `LICENSE_KEY` from [the store](https://bigmo6286.github.io/30daysmoney/?ref=github)) adds the autopilot (`/auto`), auto-rebalance and the daily report. The key is checked offline against the seller's public key in `src/license.ts`; the bot never phones home. Without a key those settings read as off and `/set` refuses to turn them on.

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
| `/scan` · `/auto` | best pools by measured fee yield · autopilot status, `/auto on\|off`, `/auto block <token>` |
| `/screen <token>` | Jev risk check on any token: copycat, rug signs, risk, plus the on-chain facts behind them |

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

### Autopilot token screening

Before the autopilot opens a pool it reads the token contract on-chain (owner, upgradeable proxy, admin functions like `mint` / `blacklist` / tax setters, share of supply in the pool) and asks [Jev](https://docs.typesafe.ai) three typed questions in one request: does the name imitate another project, can the deployer still take value from holders, and how risky is LP-ing it overall. The thresholds that block an open are settings, so you can tune them without touching the prompt. Each token is judged at most once per 24h.

Set `TYPESAFE_API_KEY` in `.env` (and optionally `JEV_MODEL` to pin a version). With screening on and no key, the autopilot opens nothing and tells you so once.

| key | default | |
|---|---|---|
| `autoScreen` | on | screen every token before auto-opening |
| `autoMaxCopycatPct` | 50 | block if P(copycat name) is above this |
| `autoMaxRugPct` | 40 | block if P(deployer can drain holders) is above this |
| `autoMaxRiskPct` | 60 | block if overall risk (0 low … 100 extreme) is above this |

A blocked token goes on cooldown for `autoCooldownHours`. If Jev can't be reached, that candidate is skipped this scan with no cooldown.

## Setup (5 minutes)

You need Node 20+ (or Docker), a Telegram bot token from [@BotFather](https://t.me/BotFather), and your numeric Telegram id from [@userinfobot](https://t.me/userinfobot).

```bash
cp .env.example .env     # fill in TG_TOKEN and TG_OWNER_ID (and ALCHEMY_KEY if you have one), leave MODE=paper
npm install
npm run smoke            # one paper pass on the real chain: RPC, Telegram token, scan, round trip, Jev, open/close
npm start
```

`npm run smoke` sends no Telegram message and signs nothing; it uses a throwaway data directory. With `ALCHEMY_KEY` set, reads and sends go through Alchemy and the pool scanner's `eth_getLogs` stays on the chain's public RPC, because Alchemy's free tier allows only 10 blocks per `eth_getLogs` call (`LOGS_RPC_URL` overrides this).

Live check (Oct 17, Robinhood Chain): 247 active WETH pools indexed from 30k blocks of Swap logs, round trips on the deepest pools, Jev refused USDG (rug signs 84%: it is a regulated stablecoin with freeze/blacklist powers, so this is a false positive, and harmless here), and PIPEDOG (risk 2%) went through paper open → value from chain → close.

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
