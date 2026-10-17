# Checkout

Sell the bots for USDC on **Solana** or **Base**, straight into your own wallet. A landing page, orders with unique amounts, an on-chain payment watcher, a signed license key per sale, and a Telegram ping when money lands.

**It never holds keys or funds.** The server knows only your *receiving* addresses. Buyers send USDC from their wallet to yours; the server just reads the chain.

## How a sale works

1. The buyer picks a product, a chain and gives a contact (Telegram @handle or email).
2. The order gets a **unique amount**: the price plus 1–9,999 micro-USDC (`49.000137`). No two orders on the same chain share an amount for a week, so a plain transfer identifies its order. No memo, no wallet plugin.
3. The page shows the amount, your address, and a wallet link (Solana Pay on Solana, EIP-681 on Base), then polls.
4. Every 15s the watcher reads new USDC transfers to your address:
   - Solana: signatures for your USDC token account → token-balance deltas of each transaction.
   - Base: `Transfer` logs of the USDC contract to your address, 3 blocks behind the head.
5. A match marks the order paid, issues an ed25519-signed license key, appends `data/sales.csv`, and pings your Telegram. The buyer's page shows the key and the product's delivery text (e.g. "send your GitHub username to…").

Paid after the order expired? Still matched, flagged `late`. Wrong amount? Logged as unmatched for you to sort out by hand.

## Setup

```bash
cp .env.example .env
npm install
npm run keygen          # paste LICENSE_PRIVATE_KEY into .env, keep the public key
npm start               # http://localhost:8787
```

Production, with HTTPS from Caddy: point a domain at the VPS, add `DOMAIN=pay.example.com` to `.env`, then

```bash
docker compose up -d --build
```

Products and prices live in code (`src/config.ts`) or override them with `data/products.json`:

```json
[{ "id": "lp-bot", "name": "LP Bot Pro", "priceUsd": 49, "blurb": "…", "deliver": "…" }]
```

`npm run ledger` prints paid orders as rows for the repo's `LEDGER.md`.

## API

| | |
|---|---|
| `GET /api/products` | products (without delivery text), enabled chains, contact |
| `POST /api/orders` `{product, chain, contact}` | 201 with amount, receiver, token, payUrl, expiresAt. 10 per IP per hour |
| `GET /api/orders/:id` | status; once paid also the license key and delivery text |

## Checking a license

```ts
import { verify } from "./src/license";
verify(key, PUBLIC_KEY_FROM_KEYGEN); // → { order, product, contact, issued } or null
```

## Tests

```bash
npm run typecheck && npm test
```

Covers unique amounts, matching (wrong chain, wrong amount, replays, late payments), persistence, license forgery, the Solana token-account derivation (checked against `@solana/spl-token`), Solana balance-delta parsing, Base log parsing and cursors, the HTTP API (validation, rate limit, what is hidden before payment) and config checks. The watchers are tested against hand-written fixtures in the RPCs' documented response shapes; they have not yet watched a real payment.
