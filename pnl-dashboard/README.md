# PnL dashboard

One page for every LP position you run: our bots' positions with exact PnL, plus any wallet's **Uniswap v3** positions (Robinhood Chain, Base, Arbitrum) and **Meteora DLMM** positions (Solana). Read-only: it never needs a private key.

Rebuild of FlipZ3ro's poolpnl, which only covered Uniswap v4 on Robinhood Chain and got several numbers wrong (deposits valued at today's price, fees counted as withdrawals, prices inverted for half the pools, failed reads silently dropped, and an open RPC relay spoofing another site's origin).

## In the browser (GitHub Pages)

`web/` is a version that runs entirely in the browser, deployed by `pages.yml` to `https://<owner>.github.io/<repo>/dashboard/`. It needs no server and no account. Wallet addresses and history stay in the viewer's `localStorage`. Positions are read straight from public RPCs.

It reads the following:
- Uniswap v3 on Robinhood Chain, Base and Arbitrum.
- Uniswap v4 on Robinhood Chain. Token ids come from the PositionManager's Transfer logs, and prices and fees from StateView.
- Meteora DLMM on Solana. This needs the viewer's own RPC URL (Settings), because Solana's public RPC refuses browsers. A free Helius key works.

| | Free | Pro |
|---|---|---|
| Wallets | 1 | 20 |
| Value, unclaimed fees, range per position | ✓ | ✓ |
| History (hourly readings, 180 days, charts and table) | | ✓ |
| CSV export (positions and history) | | ✓ |
| Auto-refresh (2 min) | | ✓ |
| Share card (image for X / Telegram, no address, amounts optional) | ✓ | ✓ |
| Range alerts on Telegram (`/watch 0x…` in the shop bot, up to 5 EVM wallets, checked ~every 15 min) | | ✓ |

Pro is unlocked offline. The viewer pastes a license key from checkout, and the page checks its ed25519 signature against checkout's public key. The keys that work are `pnl-pro` (30 days, expires), `pnl-lifetime`, or any bot license.

A refresh where a chain that previously held positions failed to read is not recorded, so a dead RPC never draws a fake drop in the history.

```bash
npm run build:web -- dist/dashboard   # index.html + app.js (+ a Solana chunk, loaded only for Solana wallets)
```

## What it shows (server version)

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
| any EVM wallet | unknown (shows value and fees, no PnL) | NonfungiblePositionManager: amounts at the current price + a static `collect` for unclaimed fees, in ETH for WETH pairs and in USD for pairs quoted in a known stablecoin (USDG on Robinhood Chain, USDC on Base/Arbitrum; lookalikes at other addresses are not valued) |
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

The integration test starts a local chain with the real Uniswap v3 contracts (lp-bot's test environment), lets lp-bot open real positions in both pool orientations, trades through them, then checks that the dashboard's reading of the wallet matches lp-bot's own value and fees to 1e-9 ETH. That check found that the on-chain view alone misses the bot's leftover token, now added in. Live check (Oct 17): the Solana reader read three real Meteora LP wallets (found from a live pool's recent add-liquidity transactions) on the public RPC in ~300 ms each. Alchemy's free tier refuses that read (the SDK scans the whole DLMM program, over its compute budget), so `ALCHEMY_KEY` is used for the EVM chains only. The EVM reader on real Robinhood Chain wallets found one bug: it read a wallet's *oldest* 200 position NFTs, one at a time. A bot wallet holding ~15k NFTs (it never burns them) took 92 s and showed nothing, though it had a live position. It now reads the newest 200, six at a time, retrying on rate limits (Alchemy's free tier caps compute units per second): 35 s, and the live position shows.
