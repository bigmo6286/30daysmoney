/**
 * Paid guides on a public site: the guide is rendered to HTML and encrypted (AES-256-GCM) here,
 * only the ciphertext is committed and published, and public/guide.html decrypts it in the
 * browser with the key from the link's #fragment (never sent to any server). The shop delivers
 * that link after payment, filling the key in from the GUIDE_KEY secret.
 *
 *   npm run guide -- key                        print a new random key (put it in the GUIDE_KEY secret)
 *   GUIDE_KEY=… npm run guide -- encrypt <guide.md> <public/guides/name.json>
 *
 * Anyone with the link can read the guide, like anyone with a PDF can; the point is that the
 * repository and the store page alone don't give it away.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { marked } from "marked";

export interface Sealed {
  v: 1;
  iv: string;
  /** ciphertext followed by the 16-byte GCM tag, base64 (the layout WebCrypto expects) */
  ct: string;
}

export function newGuideKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function keyBytes(key: string): Buffer {
  const k = Buffer.from(key.trim(), "base64url");
  if (k.length !== 32) throw new Error("GUIDE_KEY must be 32 bytes, base64url (npm run guide -- key)");
  return k;
}

export function sealGuide(html: string, key: string): Sealed {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const body = Buffer.concat([c.update(html, "utf8"), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString("base64"), ct: body.toString("base64") };
}

export function openGuide(s: Sealed, key: string): string {
  const all = Buffer.from(s.ct, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(s.iv, "base64"));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8");
}

export function renderGuide(md: string): string {
  return marked.parse(md, { async: false }) as string;
}

/** The buyer's reading link: the key rides in the fragment, which browsers never send. */
export const guideUrl = (storeUrl: string, name: string, key: string) => `${storeUrl.replace(/\/?$/, "/")}guide.html#g=${encodeURIComponent(name)}&k=${key}`;

if (process.argv[1] && /guide\.[jt]s$/.test(process.argv[1])) {
  const [cmd, src, out] = process.argv.slice(2);
  if (cmd === "key") console.log(newGuideKey());
  else if (cmd === "encrypt" && src && out) {
    const key = process.env.GUIDE_KEY || "";
    fs.writeFileSync(out, JSON.stringify(sealGuide(renderGuide(fs.readFileSync(src, "utf8")), key)) + "\n");
    console.log(`wrote ${out}`);
  } else throw new Error("usage: guide key | GUIDE_KEY=… guide encrypt <guide.md> <out.json>");
}
