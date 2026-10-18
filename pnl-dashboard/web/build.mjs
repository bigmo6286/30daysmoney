// Browser build of the dashboard: `node web/build.mjs <outDir>` → index.html + app.js + chunks.
// The Solana libraries land in their own chunk, fetched only when a Solana wallet is added.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.resolve(process.argv[2] || path.join(here, "dist"));
fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: { app: path.join(here, "main.ts") },
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  chunkNames: "chunks/[name]-[hash]",
  alias: { "node:module": path.join(here, "node-module-shim.ts"), util: path.join(here, "util-shim.ts") },
  inject: [path.join(here, "buffer-inject.ts")],
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  logLevel: "warning",
});
// link previews need absolute URLs: STORE_URL is the Pages root (pages.yml sets it); locally, relative
const store = (process.env.STORE_URL || "../").replace(/\/?$/, "/");
fs.writeFileSync(path.join(out, "index.html"), fs.readFileSync(path.join(here, "index.html"), "utf8").replaceAll("{{STORE_URL}}", () => store));
fs.copyFileSync(path.join(here, "og.png"), path.join(out, "og.png"));
const size = (f) => fs.statSync(f).size;
const files = fs.readdirSync(out, { recursive: true }).filter((f) => f.endsWith(".js"));
console.log(`wrote ${out}: ${files.map((f) => `${f} ${(size(path.join(out, f)) / 1024).toFixed(0)}KB`).join(", ")}`);
