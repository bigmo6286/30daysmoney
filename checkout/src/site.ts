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

export interface LearnPage {
  slug: string;
  title: string;
  desc: string;
}

/** `<!-- title: … | desc: … -->` on a guide's first line */
export function learnMeta(slug: string, body: string): LearnPage {
  const m = /^<!--\s*title:\s*(.+?)\s*\|\s*desc:\s*(.+?)\s*-->/.exec(body);
  if (!m) throw new Error(`learn/${slug}: first line must be <!-- title: … | desc: … -->`);
  if (/["<>]/.test(m[1]! + m[2]!)) throw new Error(`learn/${slug}: no quotes or angle brackets in title/desc`);
  return { slug, title: m[1]!, desc: m[2]! };
}

export function renderLearn(head: string, foot: string, body: string, p: LearnPage, storeUrl: string): string {
  const fill = (t: string) =>
    t.replaceAll("{{TITLE}}", () => p.title).replaceAll("{{DESC}}", () => p.desc).replaceAll("{{SLUG}}", () => p.slug).replaceAll("{{STORE_URL}}", () => storeUrl.replace(/\/?$/, "/"));
  return fill(head) + body.replace(/^<!--[\s\S]*?-->\n?/, "") + foot;
}

function buildLearn(src: string, out: string, storeUrl: string): LearnPage[] {
  if (!fs.existsSync(src)) return [];
  const head = fs.readFileSync(path.join(src, "_head.html"), "utf8");
  const foot = fs.readFileSync(path.join(src, "_foot.html"), "utf8");
  fs.mkdirSync(out, { recursive: true });
  const pages: LearnPage[] = [];
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith(".body.html")).sort()) {
    const slug = f.replace(/\.body\.html$/, "");
    const body = fs.readFileSync(path.join(src, f), "utf8");
    const p = learnMeta(slug, body);
    fs.writeFileSync(path.join(out, `${slug}.html`), renderLearn(head, foot, body, p, storeUrl));
    pages.push(p);
  }
  const index = { slug: "index", title: "LP guides: Uniswap v3/v4 and Meteora DLMM", desc: "Short, practical guides for liquidity providers on Robinhood Chain, Base, Arbitrum and Solana." };
  const list = `<h1>${index.title}</h1>\n<p class="lead">${index.desc}</p>\n<ul>\n${pages.map((p) => `<li><a href="${p.slug}.html">${p.title}</a><br><span style="color:var(--muted);font-size:15px">${p.desc}</span></li>`).join("\n")}\n</ul>\n`;
  fs.writeFileSync(path.join(out, "index.html"), renderLearn(head, foot, list, index, storeUrl).replace(`learn/index.html"`, `learn/"`));
  return pages;
}

export const sitemap = (storeUrl: string, paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${storeUrl.replace(/\/?$/, "/")}${p}</loc></url>`).join("\n")}\n</urlset>\n`;

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
  // search-friendly guides (public/learn/*.body.html), their index, and a sitemap
  const store = (process.env.STORE_URL || "").trim() || pagesUrl(process.env.REPO_URL || "https://github.com/bigmo6286/30daysmoney");
  const pages = buildLearn(path.join(pub, "learn"), path.join(out, "learn"), store);
  fs.writeFileSync(path.join(out, "sitemap.xml"), sitemap(store, ["", "dashboard/", "learn/", ...pages.map((p) => `learn/${p.slug}.html`)]));
  fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${store.replace(/\/?$/, "/")}sitemap.xml\n`);
  console.log(`wrote ${path.join(out, "index.html")} + ${pages.length} guides`);
}
