/** Print paid orders as rows for the repo's LEDGER.md. */
import path from "node:path";
import { OrderBook, fmtUsdc } from "./orders";

const book = new OrderBook(path.resolve(process.env.DATA_DIR || "data"));
const paid = book.all().filter((o) => o.status === "paid").sort((a, b) => a.paid!.at - b.paid!.at);
for (const o of paid) {
  console.log(`| ${new Date(o.paid!.at).toISOString().slice(0, 10)} | ${o.product} (USDC/${o.chain}) | ${Number(fmtUsdc(o.amountMicro)).toFixed(2)} | order ${o.id} · tx ${o.paid!.txid.slice(0, 16)}… |`);
}
const total = paid.reduce((a, o) => a + o.amountMicro, 0) / 1e6;
console.log(`\n**Total: $${total.toFixed(2)}** from ${paid.length} sales`);
