# PnL dashboard

One page for every LP position you run: our bots' positions with exact PnL, plus any wallet's **Uniswap v3** positions (Robinhood Chain, Base, Arbitrum) and **Meteora DLMM** positions (Solana). Read-only: it never needs a private key.

Rebuild of FlipZ3ro's poolpnl, which only covered Uniswap v4 on Robinhood Chain and got several numbers wrong (deposits valued at today's price, fees counted as withdrawals, prices inverted for half the pools, failed reads silently dropped, and an open RPC relay spoofing another site's origin).

## What it shows

- Per unit (ETH, SOL): open value, unclaimed fees, unrealized PnL (where the cost basis is known), realized PnL and win rate.
- A 12-week calendar of daily realized PnL (blue profit, red loss, gray none; hover for the number) and the same data as a table.
- Open positions: deposit, value, fees, PnL, in/out of range. Closed positions: deposit, returned, PnL, hold time, why it closed.
- CSV export (formula-safe for spreadsheets).
- **Honest gaps**: an RPC that fails shows an "Incomplete" banner naming the wallet; positions it can't value show "–", never 0.

## Where the numbers come from

| Source | Cost basis | Value |
|---|---|---|
| lp-bot book (`LPBOT_DATA`) | exact, recorded at open | on-chain, when the bot wallet is in `WALLETS`; includes tokens left in the wallet and fees already collected, so it matches the bot's own `/list` |
| dlmm-agent book (`DLMM_DATA`) | exact | on-chain via the Meteora SDK when the wallet is listed |
| any EVM wallet | unknown (shows value and fees, no PnL) | NonfungiblePositionManager: amounts at the current price + a static `collect` for unclaimed fees, in ETH for WETH pairs |
| any Solana wallet | unknown | Meteora SDK `getAllLbPairPositionsByUser`, in SOL for SOL pairs |

Paper positions are listed with their deposit; their live value is in the bot.

## Run

```bash
cp .env.example .env   # point LPBOT_DATA / DLMM_DATA at the bots' data, add WALLETS
npm install
npm start              # http://127.0.0.1:8790
```

Exposed on a domain with HTTPS: set `DASHBOARD_PASSWORD` (12+ chars) and `DOMAIN` in `.env`, then `docker compose up -d --build`. It refuses to listen beyond localhost without a password.

## Tests

```bash
npm run typecheck && npm test
npm run test:integration   # needs ../lp-bot dependencies installed
```

The integration test starts a local chain with the real Uniswap v3 contracts (lp-bot's test environment), lets lp-bot open real positions in both pool orientations, trades through them, then checks that the dashboard's reading of the wallet matches lp-bot's own value and fees to 1e-9 ETH. That check found that the on-chain view alone misses the bot's leftover token, now added in. The Solana reader is typechecked against the SDK but has not read a live wallet yet (Solana RPCs are unreachable from the build environment).
