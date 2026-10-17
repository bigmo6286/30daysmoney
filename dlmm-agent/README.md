# DLMM Agent

Meteora DLMM liquidity on Solana, run from Telegram. The agent scans Meteora's trending pools, opens single-sided SOL positions on the best one that passes every safety gate, and closes them on stop loss, trailing take-profit, out-of-range or faded yield. Every decision is plain code with a setting behind it. No LLM picks trades.

## Why this one

| | |
|---|---|
| 🧪 **Paper mode by default** | Reads real pools, moves virtual positions with the real active bin, sends nothing. Live mode needs `MODE=live` *and* a key. |
| 🛡 **Simulated before sent** | Every transaction is simulated first; a failure is reported and costs nothing. Sends carry a priority fee and a compute limit measured from the simulation, and are re-broadcast until confirmed or expired. |
| 🛑 **Stop loss on by default** | −15%, checked every 30s at any position age. A rug at −90% is still cut. |
| 🔍 **Gates before every open** | freeze authority, permanent delegate, transfer hooks and fees, live mint authority, top-10 holder share, a Jupiter buy→sell round trip, and optional [Jev](https://docs.typesafe.ai) screening for copycats and rug setups. |
| 📏 **Range from your risk** | You set how far the price may fall (`downsidePct`); the bin count follows from the pool's bin step. |
| 💰 **PnL from the chain** | Position value comes from the position account through the official SDK, not from a third-party PnL API. Realized PnL is the wallet's SOL balance difference. |
| 🔒 **Owner-only, no web port** | Only your Telegram id is served. Nothing listens on the network. |

## How it trades

1. **Scan** (every `scanMin`): Meteora pool discovery, SOL pairs only, filtered by TVL, volume, fee/TVL, market cap, holders, organic score, bin step and token age. Ranked by fee yield × organic score, halved when another pool trades the same ticker (⚔️ PVP).
2. **Gate** the best candidate not held, blocked or cooling down: mint facts → round trip → Jev.
3. **Open** `sizeSol` single-sided SOL, spot distribution, range spanning a `downsidePct` fall. At most one open per scan, `maxOpen` positions, `dailySol` per UTC day, `gasReserveSol` always kept.
4. **Manage** (every `manageSec`): value, PnL, peak, range. Close on the first exit rule that fires, claim fees, swap the token side back to SOL, cool the token down for `cooldownHours`.

## Commands

| | |
|---|---|
| `/status` | wallet, every open position with value, fees, PnL, range, and close buttons |
| `/history` | closed positions, win rate, total PnL |
| `/scan` | top pools right now, with skip reasons and cached Jev risk |
| `/check <pool\|mint>` | run every gate on one token and show the facts |
| `/open <pool\|mint> [SOL]` | gates, then a confirm button |
| `/close <id>` · `/closeall` | close (with confirm) |
| `/auto` · `/auto on\|off` · `/auto block <mint>` | autopilot status and switches |
| `/settings` · `/set <key> <value>` | every threshold is live-editable |

### Key settings

| key | default | |
|---|---|---|
| `sizeSol` / `maxOpen` / `dailySol` | 0.1 / 3 / 0.5 | size and caps |
| `downsidePct` | 40 | range covers a fall this deep (15–69 bins) |
| `stopLossPct` | 15 | 0 = off |
| `trailArmPct` / `trailDropPct` | 5 / 3 | trailing take-profit |
| `takeProfitPct` | 0 (off) | fixed take-profit |
| `oorAboveMin` / `oorBelowMin` | 15 / 30 | close after this long above / below the range |
| `minFeeTvlPctHold` | 0.05 | close when the pool's fee yield fades below this (after 60m) |
| `timeframe` | 4h | screening window for volume and fee/TVL |
| `minFeeTvlPct` / `minTvlUsd` / `minOrganic` | 0.4 / 10k / 60 | entry filters |
| `requireMintRenounced` / `maxTop10Pct` / `maxRoundTripLossPct` | on / 50 / 5 | token gates |
| `screen` · `maxCopycatPct` / `maxRugPct` / `maxRiskPct` | on · 50 / 40 / 60 | Jev thresholds |

## Setup

You need Node 20+ (or Docker), a Telegram bot token from [@BotFather](https://t.me/BotFather), your numeric Telegram id from [@userinfobot](https://t.me/userinfobot), and ideally a paid Solana RPC.

```bash
cp .env.example .env     # TG_TOKEN, TG_OWNER_ID, RPC_URL, TYPESAFE_API_KEY; leave MODE=paper
npm install
npm start
```

Run it in paper for a few days, watch `/status` and `/history`, tune with `/set`. For real funds: a **fresh wallet** holding only what you're willing to lose, `MODE=live`, `WALLET_KEY`, restart.

```bash
docker compose up -d --build   # 24/7 on a VPS; state lives in the dlmm-data volume
```

## Paper mode is an estimate

Price moves are real (the pool's live active bin). The position is modelled as a uniform spot deposit: bins the price crosses are converted to the token at their own price. Fees are estimated from the pool's fee/TVL rate while in range, which ignores your share of the active bin. Treat paper PnL as a direction, not a promise.

## Development

```bash
npm run typecheck
npm test          # range math, paper model, exit rules, screening, gates, Jev, the agent loop and Telegram flow with fakes
```

```
src/
├── index.ts          entrypoint
├── config.ts         .env + live-editable settings (zod)
├── range.ts          bins from downside, ranges, paper value model
├── exits.ts          exit rules
├── positions.ts      position book
├── chain/            Solana send path, Meteora SDK (paper + live executors), Jupiter, mint facts
├── auto/             discovery, screening, gates, Jev, the agent loop
└── bot/              Telegram client + commands
```
