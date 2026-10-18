/**
 * `npm run site -- <outDir>`: the static store page for GitHub Pages. Products come from the same
 * list the shop sells (src/config.ts or data/products.json), without the delivery text.
 */
import fs from "node:fs";
import path from "node:path";
import { loadProducts } from "./config";

export interface StoreOptions {
  products: { id: string; name: string; priceUsd: number; blurb: string; days?: number }[];
  shopBot: string;
  repoUrl: string;
  checkEveryMin: number;
  /** seller contact, shown in the FAQ and footer */
  contact?: string;
  /** the Pages root, for absolute link-preview URLs; derived from repoUrl when not given */
  storeUrl?: string;
  /** the shop's receiving addresses, so a buyer can check the one the bot gives them */
  receivers?: { base?: string; solana?: string };
}

/** https://github.com/<owner>/<repo> → https://<owner>.github.io/<repo>/ (relative when it isn't GitHub) */
export const pagesUrl = (repoUrl: string) => {
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repoUrl);
  return m ? `https://${m[1]!.toLowerCase()}.github.io/${m[2]!.replace(/\.git$/, "")}/` : "./";
};

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function renderStore(tpl: string, o: StoreOptions): string {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(o.shopBot)) throw new Error("SHOP_BOT must be the shop bot's Telegram username, without @");
  // JSON inside <script>: escape "<" so a product text can never close the tag
  const products = json(o.products.map(({ id, name, priceUsd, blurb, days }) => ({ id, name, priceUsd, blurb, ...(days ? { days } : {}) })));
  const site = json({ contact: o.contact ?? "", receivers: { base: o.receivers?.base || undefined, solana: o.receivers?.solana || undefined } });
  // replacer functions: a "$&" in a product text must stay literal
  return tpl
    .replaceAll("{{PRODUCTS_JSON}}", () => products)
    .replaceAll("{{SITE_JSON}}", () => site)
    .replaceAll("{{SHOP_BOT}}", () => o.shopBot)
    .replaceAll("{{REPO_URL}}", () => o.repoUrl.replace(/"/g, ""))
    .replaceAll("{{CHECK_EVERY_MIN}}", () => String(o.checkEveryMin))
    .replaceAll("{{STORE_URL}}", () => (o.storeUrl || pagesUrl(o.repoUrl)).replace(/"/g, "").replace(/\/?$/, "/"));
}

if (process.argv[1] && /site\.[jt]s$/.test(process.argv[1])) {
  const out = path.resolve(process.argv[2] || "_site");
  const tpl = fs.readFileSync(new URL("../public/store.html", import.meta.url), "utf8");
  const html = renderStore(tpl, {
    products: loadProducts(path.resolve(process.env.DATA_DIR || "data")),
    shopBot: (process.env.SHOP_BOT || "").replace(/^@/, "").trim(),
    repoUrl: process.env.REPO_URL || "https://github.com/bigmo6286/30daysmoney",
    checkEveryMin: Number(process.env.CHECK_EVERY_MIN || 15),
    contact: (process.env.CONTACT || "").trim(),
    storeUrl: (process.env.STORE_URL || "").trim() || undefined,
    receivers: { base: (process.env.BASE_RECEIVER || "").trim(), solana: (process.env.SOL_RECEIVER || "").trim() },
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html);
  // paid guides: the reader page and the encrypted guides (never the plain text)
  const pub = new URL("../public/", import.meta.url).pathname;
  fs.copyFileSync(path.join(pub, "guide.html"), path.join(out, "guide.html"));
  fs.copyFileSync(path.join(pub, "og.png"), path.join(out, "og.png"));
  const guides = path.join(pub, "guides");
  if (fs.existsSync(guides)) {
    fs.mkdirSync(path.join(out, "guides"), { recursive: true });
    for (const f of fs.readdirSync(guides)) if (f.endsWith(".json")) fs.copyFileSync(path.join(guides, f), path.join(out, "guides", f));
  }
  console.log(`wrote ${path.join(out, "index.html")}`);
}
