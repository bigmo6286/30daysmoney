# Be findable (option 4: one-time listings, no posting)

Each step takes a few minutes, once. Visitors who arrive this way are tagged in `/stats` by the links' `?ref=`.

## Already done in the repo

- **Search guides** at `STORE/learn/`: four how-to pages aimed at real searches:
  - tracking Uniswap v4 positions on Robinhood Chain;
  - Meteora DLMM position tracking;
  - a Robinhood Chain LP bot;
  - out-of-range alerts.
  Each has a canonical URL, a description, a preview image and Article structured data.
- **Sitemap** at `STORE/sitemap.xml`, listing the store, the dashboard and every guide.
- **Link previews** (Open Graph / X cards) on the store, the dashboard and every guide.
- **The README** leads with the store and dashboard links.

## Your part (about 20 minutes total)

1. **Google Search Console** (search.google.com/search-console):
   - Add the property `https://bigmo6286.github.io/30daysmoney/` (URL prefix).
   - Verify it with the HTML-tag method: send me the tag and I'll add it to the pages.
   - Submit `sitemap.xml`.
   Without this, Google may take weeks to find the pages.
2. **Bing Webmaster Tools**: import from Google Search Console in one click. Bing also feeds DuckDuckGo and several AI search tools.
3. **GitHub repo settings** (the ⚙ next to "About" on the repo page):
   - Description: *Open-source LP tools: Telegram bots for Uniswap v3/v4 (Robinhood Chain) and Meteora DLMM, a free LP PnL dashboard, flash-loan kit.*
   - Website: `https://bigmo6286.github.io/30daysmoney/?ref=github`
   - Topics: `uniswap`, `uniswap-v4`, `meteora`, `dlmm`, `solana`, `robinhood-chain`, `liquidity-provider`, `defi`, `telegram-bot`, `flash-loan`
   Topics are how GitHub search and "explore" surface repos.
4. **Directory listings** (submit once each):
   - Alchemy's Dapp Store has Robinhood Chain categories ("DeFi tools", "analytics tools"). Submit the dashboard as an analytics tool and LP Bot as a DeFi tool.
   - DappRadar and The Grid: Alchemy's directory draws on these too.
   - Use the store's preview image (`STORE/og.png`) and the one-line descriptions from the README table.
