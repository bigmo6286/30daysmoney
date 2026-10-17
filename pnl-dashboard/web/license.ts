/**
 * Pro check in the browser, offline: the same ed25519-signed keys checkout issues for the bots.
 * A PnL Pro key (monthly, with an expiry, or lifetime) unlocks it, and so does any bot license:
 * the dashboard comes free with LP Bot Pro and DLMM Agent Pro.
 */
import { ed25519 } from "@noble/curves/ed25519";

/** checkout's license signing key, SPKI (same key the bots embed) */
export const LICENSE_PUBLIC_KEY = "MCowBQYDK2VwAyEAEEZ1U8Rn6pYcKEMFGobqSRMXW/NABOo4mnt9S8bVIuo=";
export const PRO_PRODUCTS = ["pnl-pro", "pnl-lifetime", "lp-bot", "lp-bot-setup", "dlmm-agent", "dlmm-agent-setup"];

export interface License {
  order: string;
  product: string;
  contact: string;
  issued: number;
  /** ms since epoch; absent = never expires */
  expires?: number;
}

export type Check = { pro: true; license: License } | { pro: false; reason: string };

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s: string) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
/** an ed25519 SPKI is a fixed 12-byte header + the 32-byte key */
const rawKey = (spki: string) => b64(spki).slice(-32);

export function checkLicense(key: string, now = Date.now(), publicKey = LICENSE_PUBLIC_KEY): Check {
  const k = key.trim();
  if (!k) return { pro: false, reason: "no key" };
  const [body, sig] = k.split(".");
  if (!body || !sig) return { pro: false, reason: "that doesn't look like a license key" };
  let ok = false;
  try {
    ok = ed25519.verify(b64url(sig), new TextEncoder().encode(body), rawKey(publicKey));
  } catch {
    ok = false;
  }
  if (!ok) return { pro: false, reason: "this key isn't valid" };
  let lic: License;
  try {
    lic = JSON.parse(new TextDecoder().decode(b64url(body))) as License;
  } catch {
    return { pro: false, reason: "this key isn't valid" };
  }
  if (!PRO_PRODUCTS.includes(lic.product)) return { pro: false, reason: `this key is for ${lic.product}` };
  if (lic.expires !== undefined && lic.expires < now) return { pro: false, reason: `this key expired on ${new Date(lic.expires).toISOString().slice(0, 10)}` };
  return { pro: true, license: lic };
}
