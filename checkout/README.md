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

## Serverless shop (free: GitHub Pages + Telegram + GitHub Actions)

No server and no domain. The store page is on GitHub Pages; "Buy" opens a Telegram shop bot; a scheduled GitHub Action runs every 5 minutes, answers the bot, watches the chain and DMs the license key when the payment lands.

```
store page (Pages) ──▶ t.me/<shop bot>?start=buy_lp-bot ──▶ bot: pick chain → exact amount + address
                                                                   │
buyer's wallet ── USDC ──▶ your wallet          every 5 min: .github/workflows/shop.yml (npm run tick)
                                                  reads Telegram + USDC transfers → match → key in the chat
```

One-time setup (all in GitHub, a few minutes):

1. **A second Telegram bot for the shop** (@BotFather → `/newbot`). Don't reuse the lp-bot's token: two programs can't both read one bot's messages.
2. **Settings → Secrets and variables → Actions → Secrets:**
   - `SHOP_TG_TOKEN`: the shop bot's token.
   - `LICENSE_PRIVATE_KEY`: the signing key whose public half is built into the bots. Keep a copy offline; losing it means re-issuing keys.
   - `ALCHEMY_KEY`.
   - `TG_OWNER_ID`: your numeric Telegram id, for sale pings. Message the shop bot once so it can write to you.
3. **Variables:**
   - `BASE_RECEIVER` and/or `SOL_RECEIVER`.
   - `CONTACT` (your @handle).
   - `SHOP_BOT` (the shop bot's username, without @).
   - `SHOP_ENABLED` = `true`.
4. **Settings → Pages → Source: GitHub Actions**, then run the `pages` workflow once (Actions tab). The store is at `https://<owner>.github.io/<repo>/`.

Notes:
- **How long a key takes:** GitHub runs schedules every 5 minutes at best, and later under load. Buyers are told their key arrives within ~15 minutes.
- **Where the state lives:** orders, buyer chat ids, keys and chain cursors are carried between runs in the Actions cache as one AES-256-GCM file. Its key is derived from `LICENSE_PRIVATE_KEY`, so workflows from forks, which can read caches but never get secrets, see only noise. A failed decrypt never overwrites the saved state.
- **If the cache is lost** (unused for 7 days): open orders are gone, but a payment that can't be matched pings you with its tx, so you can issue the key by hand.
- **GitHub pauses schedules after 60 days without commits.** Push something, or re-enable the workflow.
- **Public repos run Actions free.** On a private repo the schedule uses about 9k minutes a month.

### Paid guides

The repo is public, so a paid guide can't sit in it as text. Instead:
- **Only the encrypted guide is committed:** `public/guides/<name>.json`, AES-256-GCM.
- **The plain text never enters the repo.** Keep it safe yourself.
- **Reading:** `guide.html` on the store decrypts it in the buyer's browser, with the key from the link's `#k=…` fragment. Browsers never send a fragment to any server.
- **Delivery:** a product whose delivery text contains `{{GUIDE_URL:<name>}}` gets the full link when it's paid for, with the key from the `GUIDE_KEY` secret.
- **No key, no sale:** without `GUIDE_KEY` the shop doesn't offer that product.

```bash
npm run guide -- key                                              # once: a new key → GitHub secret GUIDE_KEY
GUIDE_KEY=… npm run guide -- encrypt guide.md public/guides/flash-loans.json   # after every edit; commit the .json
```

Anyone with the link can read it, as with a PDF. What this protects against is the repository or the store page giving the guide away.

## Setup (own server)

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

Covers unique amounts, matching (wrong chain, wrong amount, replays, late payments), persistence, license forgery, the Solana token-account derivation (checked against `@solana/spl-token`), Solana balance-delta parsing, Base log parsing and cursors, the HTTP API (validation, rate limit, what is hidden before payment) and config checks. Live checks (Oct 17): 192 real USDC `Transfer` logs (Ethereum mainnet, same event as Base) all parse and agree with their receipts. Running against mainnet also found two bugs, both fixed and tested: Solana now has **v1 transactions**, which an RPC refuses unless asked for (one such payment would have blocked every later one), and public RPCs signal rate limits inside 200 responses (`-32011`). The public Base and Solana RPCs refuse `eth_getLogs`/`getTransaction` from busy shared IPs, so set `ALCHEMY_KEY` (or `BASE_RPC_URL` / `SOL_RPC_URL`) in production. With `ALCHEMY_KEY` on the free tier, `eth_getLogs` is limited to 10 blocks per call; the Base watcher used to stop shrinking at 50, so it would have failed every poll and **never seen a payment**. It now shrinks to 10 inside the same poll (one call per poll keeps up with Base's 2 s blocks); checked live against a busy Base USDC receiver (38 blocks, 8 transfers, 0.8 s). No real payment has been watched end to end yet.
