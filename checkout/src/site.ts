/**
 * `npm run site -- <outDir>`: the static store page for GitHub Pages. Products come from the same
 * list the shop sells (src/config.ts or data/products.json), without the delivery text.
 */
import fs from "node:fs";
import path from "node:path";
import { loadProducts } from "./config";

export function renderStore(tpl: string, o: { products: { id: string; name: string; priceUsd: number; blurb: string }[]; shopBot: string; repoUrl: string; checkEveryMin: number }): string {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(o.shopBot)) throw new Error("SHOP_BOT must be the shop bot's Telegram username, without @");
  // JSON inside <script>: escape "<" so a product text can never close the tag
  const products = JSON.stringify(o.products.map(({ id, name, priceUsd, blurb }) => ({ id, name, priceUsd, blurb }))).replace(/</g, "\\u003c");
  return tpl
    .replace("{{PRODUCTS_JSON}}", products)
    .replace("{{SHOP_BOT}}", o.shopBot)
    .replace("{{REPO_URL}}", o.repoUrl.replace(/"/g, ""))
    .replace("{{CHECK_EVERY_MIN}}", String(o.checkEveryMin));
}

if (process.argv[1] && /site\.[jt]s$/.test(process.argv[1])) {
  const out = path.resolve(process.argv[2] || "_site");
  const tpl = fs.readFileSync(new URL("../public/store.html", import.meta.url), "utf8");
  const html = renderStore(tpl, {
    products: loadProducts(path.resolve(process.env.DATA_DIR || "data")),
    shopBot: (process.env.SHOP_BOT || "").replace(/^@/, "").trim(),
    repoUrl: process.env.REPO_URL || "https://github.com/bigmo6286/30daysmoney",
    checkEveryMin: Number(process.env.CHECK_EVERY_MIN || 15),
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html);
  console.log(`wrote ${path.join(out, "index.html")}`);
}
