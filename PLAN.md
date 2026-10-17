# Plan

FlipZ3ro's repos are the reference. Each product here is our own rebuild that does the same job, better.

## Reference repos → our products

| Reference (FlipZ3ro) | Demand signal | Our rebuild | How we improve it |
|---|---|---|---|
| robinhood-lp-bot: Telegram LP bot, Uniswap v2/v3/v4 on Robinhood Chain | 65★ / 32 forks (strongest) | `lp-bot/` | Simulation before every tx, range auto-rebalance, PnL + IL reports in Telegram, one-command Docker deploy |
| meridian-rs / dlmm-agent: Meteora DLMM LP agent on Solana | 39★ / 15 forks | `dlmm-agent/` | Strategy presets, backtest mode, web dashboard |
| RobinArb + rh-flash-toolkit + morpho-toolkit + kamino-tools: arbitrage & flash loans | 25★, 18★, 12★, 7★ | `flash-kit/` | One CLI across EVM + Solana, dry-run profit preflight, gas/fee-aware routing |
| poolpnl | new | `pnl-dashboard/` | Hosted multi-wallet LP PnL tracker, shared by all of the above |
| hermes-quickstart / hermes-termux: Telegram AI bot bootstrap | small | `setup-scripts/` | Used for the paid setup service |

## Revenue streams

### 1. Paid bot licenses + setup: target $1,000
- **LP Bot Pro**: $49 one-time license, or $99 with done-for-you VPS setup
- **DLMM Agent Pro**: same pricing
- Need ≈ 12–20 sales. Buyers keep their own keys; we never custody funds.

### 2. Hosted PnL dashboard subscription: target $500
- Free tier: 1 wallet. Pro: $15/mo or $39 early-bird lifetime
- Bundled free with any bot license, so every sale also adds a user

### 3. Guides: target $200
- "Flash loans on Robinhood Chain & Solana", $19 on Gumroad, built from `flash-kit/`

### 4. Bounties / freelance: target $300+
- Superteam Earn, Gitcoin, Upwork: Telegram bots, LP automation, Solana/EVM scripts

## Timeline

| Days | Deliverable |
|---|---|
| 1–5 | `lp-bot/` MVP: Telegram control, add/remove liquidity on Uniswap v2/v3, simulation, testnet run |
| 6–8 | Landing page + payment links (Gumroad/Stripe + USDC). First launch posts in Robinhood Chain communities |
| 9–14 | `pnl-dashboard/` MVP, hooked into lp-bot. Start setup-service sales |
| 15–20 | `dlmm-agent/` MVP for Meteora. Second launch |
| 21–25 | `flash-kit/` + paid guide. Bounty applications |
| 26–30 | Push whatever converts best. Testimonials, upsells, discounts |

## Weekly checkpoints
Week 1: first sale · Week 2: $500 · Week 3: $1,200 · Week 4: $2,000

## Progress log

### Day 1 (2026-10-17)
- `lp-bot/` v0.1 built: Telegram flow (paste token → pool → amount → single-side/in-range → confirm), `/list` with PnL vs deposit and vs HODL, collect, close (1 tx + optional swap back to ETH), rebalance, monitor (range alerts, TP/SL, auto-rebalance), **paper mode**, Robinhood + Base + Arbitrum presets, Docker, CI.
- 41 tests passing, including an integration suite against the real Uniswap v3 contracts on a local chain.
- Bugs found and fixed while testing (both also affect the reference bot's approach on sub-second chains): stale cached reads after a transaction, nonce reuse on back-to-back sends.

- `lp-bot/` autopilot gained token screening with Jev (TypeSafe): copycat / rug-signs / risk per token before any auto-open, `/screen <token>`, warnings on manual opens. Tuned against one live call (a copycat with mint/blacklist/tax functions scored 97/93/99%, a renounced token 8/4/6%).
- `dlmm-agent/` v0.1 (rebuild of meridian-rs): Meteora DLMM on Solana from Telegram. Deterministic screening (no LLM in the loop), paper mode by default, simulate-before-send with priority fees and re-broadcast, stop loss on by default and never gated, mint red-flag gates (freeze authority, permanent delegate, transfer hooks/fees, live mint authority, top-10 share), Jupiter round-trip check, Jev screening, PnL from the chain. 27 tests. **Not yet run against mainnet**: this build environment can't reach Solana RPC, Meteora or Jupiter, so the first paper run on a VPS is the real test.

**Still needed (owner):** a Telegram bot token + a burner wallet with a little ETH on Robinhood Chain for the first mainnet run; a payment account (Gumroad / Stripe / USDC address) for sales; a Solana RPC (Helius free tier is fine) for the dlmm-agent paper run.
