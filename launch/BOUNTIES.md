# Bounty kit (revenue stream 4: $300+)

The repository is the portfolio. Each package is a finished, tested piece of work that matches a common bounty or freelance brief. Applications that link to working code and paste real numbers win over applications that describe what someone *could* build.

## Where to look

| Site | Search for | Notes |
|---|---|---|
| Superteam Earn (earn.superteam.fun) | "Telegram bot", "LP", "DLMM", "Meteora", "dashboard", "Solana data", "agent" | Solana bounties and projects. Many are open worldwide; check each listing's region. |
| Gitcoin / DoraHacks | "Uniswap v4", "hooks", "liquidity", "Robinhood Chain", "tooling" | hackathon prizes and grants |
| Upwork / Contra | "Telegram bot crypto", "Uniswap bot", "Solana bot", "LP automation" | freelance: quote fixed price per milestone |
| Robinhood Chain and Meteora Discords | the #jobs or #bounties channels | ecosystem asks, often unlisted elsewhere |

Check twice a week: most bounties close within 2–3 weeks.

## Pick bounties you've already half-built

| The brief asks for… | Point to | Proof to paste |
|---|---|---|
| Telegram bot that trades / LPs / alerts | `lp-bot/` | paper mode, simulate-before-send, 41+ tests, mainnet smoke run |
| Uniswap v4 integration (PositionManager, UniversalRouter, Permit2) | `lp-bot/src/chain/v4.ts`, `pnl-dashboard/src/sources/univ4.ts` | mainnet-fork test at a pinned block; live v4 position read: GLD/USDG $10,187 with $42.43 fees |
| Meteora DLMM agent / analytics | `dlmm-agent/` | discovery → gates → Jev → paper open/close on mainnet, presets |
| Dashboard or "something live on Solana/EVM data" | `pnl-dashboard/web/` (live at the store's `/dashboard/`) | runs in the browser, no backend, 4 chains + Meteora |
| Flash loans / arbitrage | `flash-kit/` | real Morpho Blue + Uniswap v3 on a mainnet fork: exact simulated profit paid, lender left whole |
| Crypto checkout / payments | `checkout/` | USDC on Base and Solana with no server: unique-amount orders, signed license keys, Telegram delivery |
| VPS deploy / devops scripts | `setup-scripts/` | sandboxed systemd unit, pinned releases, rollback |

Skip briefs that need what we don't have: audited contracts, a token launch, or "guaranteed APY" marketing.

## Application template

Keep it under 200 words. Reviewers read dozens.

> **What I'll deliver:** <one sentence restating their brief in your own words, with the one detail that shows you read it>.
>
> **I've already built the hard part:** <package link>. It <does X>, tested <how: mainnet fork / live run / N tests>. For example: <one real number from the table above>.
>
> **Plan:**
> 1. <milestone 1>, day 1–2
> 2. <milestone 2>, day 3–5
> 3. Handover: README, tests and a short demo video, day 6
>
> **Safety:** no custody of anyone's keys; every transaction simulated before sending; paper/dry-run mode first.
>
> Repo: github.com/bigmo6286/30daysmoney · Live demo: <store URL>dashboard/ · Contact: @marigold234

## Pricing freelance work

- Quote per milestone, not per hour, with half up front for new clients.
- Rough anchors (adjust to the brief):
  - a Telegram bot adapted from `lp-bot`: $150–$400;
  - a custom dashboard view: $100–$250;
  - a VPS install of one of our bots: $99, the store price.
- Payment in USDC to the store addresses, so it lands in `LEDGER.md` like any sale.

## Rules

- Never promise returns or yield, the same rule as the launch kit.
- Don't paste private keys, RPC keys or the license signing key into a submission or a demo video.
- Log every payout in `LEDGER.md` with the source "bounty".
