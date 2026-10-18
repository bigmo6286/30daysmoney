# Launch kit

Ready-to-post copy for the first launch (plan days 6–8). Every claim here is something we tested; keep it that way. **Never promise returns.** We sell software and setup, not yield.

Replace `STORE` with the Pages URL (`https://bigmo6286.github.io/30daysmoney/`) once the `pages` workflow has run, and `@SHOP_BOT` with the shop bot's handle.

## Positioning (one line)

> Self-hosted LP bots you control from Telegram: Uniswap v3 + v4 on Robinhood Chain, Meteora DLMM on Solana. Paper mode first, every transaction simulated, your keys never leave your server.

**Who it's for:**
- people already LPing by hand on Robinhood Chain or Meteora who are tired of babysitting ranges;
- people who tried FlipZ3ro's robinhood-lp-bot or meridian (65★ and 39★: proven demand) and want the safety pieces those don't have.

**Why ours (every point verifiable in the repo):**
- **Uniswap v4 on Robinhood Chain.** v4 has more trading there than v3. Hookless native-ETH pools only; hooked pools are refused.
- **Paper mode by default.** Same reads and quotes as live, nothing sent.
- **Every transaction simulated before it's sent.** Approvals are exact amounts, never unlimited.
- **Stop loss on by default** in the DLMM agent, and never behind the paywall.
- **Token screening before the autopilot opens anything:**
  - DLMM: freeze authority, transfer hooks and fees, mint authority, top-10 holders.
  - Both bots: a buy→sell round trip, and the Jev copycat/rug screen.
- **Free tier.** The source is public, and the free tier does manual LP plus all the safety features. Pro ($49 once) adds the autopilot, auto-rebalance and daily reports.

## Lead with the free dashboard

A free tool is easier to post than a paid bot. Groups that ban self-promo often allow it, and every user sees the bot and the Pro plan from inside it. So post the dashboard first and the bots second.

**Dashboard link:** `STORE` + `dashboard/?ref=<channel>`. For example, use `?ref=tg-rh` for the Robinhood Chain Telegram.

**Short post (dashboard):**

> Made a free, read-only LP dashboard. Paste a wallet and see every position in one place: Uniswap v3 on Robinhood Chain / Base / Arbitrum, Uniswap v4 on Robinhood Chain, and Meteora DLMM. You get value, unclaimed fees and in/out of range.
> - It runs in your browser and reads straight from the chain.
> - No sign-up, and it never asks for a signature.
> - The "Share" button makes an image of your positions for X, and leaves out your address.
>
> STOREdashboard/?ref=CHANNEL

**Share cards:** every card posted carries the dashboard link, and visits from cards arrive tagged `?ref=card`. Post your own card in the X thread below. Real positions from a real wallet beat any screenshot of a landing page.

## X / Twitter thread

1/ I rebuilt the popular Robinhood Chain LP bot from scratch, with the safety parts it was missing. It's open source, runs on your own server, and you control it from Telegram. Thread on what it does and what I found running it on mainnet 🧵

2/ Paste a token and it finds every ETH pool: Uniswap v3 *and* v4. On Robinhood Chain, v4 has more trading than v3. It only touches v4 pools without hooks (a hook is custom code that runs on every swap; no thanks).

3/ Everything starts in paper mode: real pool reads, real quotes, nothing sent. When you go live, every transaction is simulated first, and approvals are exact amounts that expire. Nothing unlimited is left behind.

4/ First mainnet runs found bugs no test could have:
- Meteora's API nests one field, so a bot reading it naively never opens a position
- Alchemy's free tier allows 10 blocks per log query, so a payment watcher silently misses payments
- some live v4 pools can't even be quoted, so the bot skips them.
All fixed.

5/ Free: manual LP, paper mode, range alerts, stop loss and take profit. Pro, $49 once in USDC (Base or Solana): the autopilot (scan, screen, open, rotate out), auto-rebalance and daily reports. Setup on your VPS for $99.

6/ Solana side: a Meteora DLMM agent with deterministic screening (no LLM picking your trades), stop loss on by default, and mint red-flag checks before every open.

7/ Code: github.com/bigmo6286/30daysmoney · Store: STORE
Not financial advice. LP can lose money. You hold your keys.

## Short post (Telegram / Discord groups for Robinhood Chain, Meteora, Solana LPs)

> Built an open-source Telegram LP bot for Robinhood Chain (Uniswap v3 + v4) and a Meteora DLMM agent for Solana.
> - It runs on your server with your keys.
> - Paper mode first; every tx is simulated.
> - Exact approvals only.
> - Stop loss and take profit in the free version (on by default in the DLMM agent).
> - It skips v4 pools with hooks.
>
> The free version does manual LP and all the safety features; Pro ($49 once, USDC) adds the autopilot. Code: github.com/bigmo6286/30daysmoney · STORE. Happy to answer questions; not financial advice.

**Group etiquette** (getting banned kills the channel):
- Read the group's rules first.
- Post once, in the channel meant for tools or self-promo.
- Stay to answer questions; people buy from someone who answers.
- Never DM people unprompted.

## Longer post (Reddit r/defi, r/solana, r/UniSwap; forums)

**Title:** I rebuilt two popular open-source LP bots with the safety features they were missing (Uniswap v4 on Robinhood Chain + Meteora DLMM)

**Body:**
1. What they do: the two bots above, controlled from Telegram.
2. What's different, as bullets from "Why ours".
3. What mainnet taught me: the 3–4 bugs above.
4. Honest limits:
   - paper PnL is an estimate;
   - most yield comes from volatile tokens, and that's where you lose money;
   - the v4 autopilot only uses hookless native-ETH pools.
5. Links. Mention the free tier first, Pro second.

## Where to post (week 1)

| Day | Where | What |
|---|---|---|
| 1 | X | thread, ending with a share card from the dashboard |
| 1 | Robinhood Chain Telegram/Discord (tools channel) | dashboard post first; the bot post a day later, as a reply to anyone who asks |
| 2 | Meteora Discord (community tools), Solana LP Telegrams | short post, DLMM angle first |
| 3 | r/defi, r/UniSwap | longer post |
| 4 | r/solana (if self-promo is allowed that day) | longer post, DLMM angle |
| 5 | reply to people asking "is there a bot for…" | answer the question first, link second |
| 7 | X | results thread: what paper runs showed, honestly |

**Track what converts:** add `?ref=x`, `?ref=tg`, `?ref=reddit` to the store link. Sales show which channel paid (the shop records every order), so after week 1 double down on the one that sold.

## Bounties (revenue stream 4)

Search Superteam Earn and Gitcoin for "Telegram bot", "LP", "DLMM", "Uniswap v4" and "Solana scripts". The repo is the portfolio: link the specific package that matches the bounty.
