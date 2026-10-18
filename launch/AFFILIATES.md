# Affiliate outreach (option 5: others post for you)

The shop bot pays affiliates `REF_PCT`% of every sale they bring (default 20%), in USDC. Your job is a one-time round of messages to the people who already have the audience. After that, they post and you pay.

## Who to message (pick 10–20)

| Who | Where to find them | Why they'd say yes |
|---|---|---|
| Admins of Robinhood Chain / Meteora / Solana LP Telegram groups | the groups' pinned "about" or "contact admin" | a free tool their members ask about, and a cut when members upgrade |
| People who post LP results on X (screenshots of Meteora / Uniswap positions) | X search: `meteora dlmm`, `robinhood chain LP`, `uniswap v4 lp` | the share card gives them better screenshots; affiliates earn on top |
| Authors of LP / DeFi YouTube tutorials and newsletters | YouTube search: "meteora dlmm tutorial", "uniswap v4 liquidity" | a ready-made tool to demo, with a link that pays |
| Discord moderators in LP communities | the #tools or #resources channels | same as group admins |

Skip anyone who promotes "guaranteed yield": they'll misrepresent the product, and it's your name on it.

## The message (DM or reply; edit the first line for each person)

> Hey [name], I saw your [post/group about X]. I built a free, read-only LP dashboard. It shows every Uniswap v3/v4 and Meteora position across wallets in one view, with a share card for posting results: [STORE]dashboard/
>
> It's open source, and the paid parts (Pro dashboard with range alerts, the LP bots) have an affiliate program: 20% of anything bought through your link, paid in USDC. If it's useful to your members, send `/invite` to [@SHOP_BOT] for your link. Happy to answer anything.

Short version for X replies:

> Free tool for this: every Uniswap v3/v4 + Meteora position in one view, read-only, with a share card. [STORE]dashboard/?ref=x-reply

## After someone says yes

1. They send `/invite` to the shop bot. Their link is ready, and nothing is needed from you.
2. When their referral pays, you get the sale alert with "affiliate u-…: owe $X → address".
3. Pay within a week, in USDC to their `/payout` address, then send `/paidout u-…` to the shop bot.
4. Tell them it's paid. A paid affiliate posts again.

## Rules

- Never promise returns or yields: the same rule as the launch kit.
- One message per person; no follow-up spam. If they don't answer, move on.
- Log commissions you pay in `LEDGER.md` as a negative row (source "affiliate").
