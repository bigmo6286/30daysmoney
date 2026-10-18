/**
 * Pro license check, offline: a key is base64url(JSON payload) + "." + base64url(ed25519 signature)
 * issued by checkout/ when a payment lands. The bot only holds the public key, so it can verify a
 * key but never mint one. No key (or a bad one) = free tier: everything except the Pro features.
 */
import crypto from "node:crypto";

/** checkout's license signing key (public half; the private half never leaves the seller) */
export const LICENSE_PUBLIC_KEY = "MCowBQYDK2VwAyEAEEZ1U8Rn6pYcKEMFGobqSRMXW/NABOo4mnt9S8bVIuo=";
export const PRODUCTS = ["dlmm-agent", "dlmm-agent-setup"];
export const PRO_NAME = "DLMM Agent Pro";
/** the store, tagged so /stats in the shop bot shows sales that came from this bot */
export const BUY_URL = "https://bigmo6286.github.io/30daysmoney/?ref=dlmm";

export interface License {
  order: string;
  product: string;
  contact: string;
  issued: number;
}

export type LicenseCheck = { pro: true; license: License } | { pro: false; reason: string };

export function checkLicense(key: string, publicKey = LICENSE_PUBLIC_KEY, products: readonly string[] = PRODUCTS): LicenseCheck {
  const k = key.trim();
  if (!k) return { pro: false, reason: "no LICENSE_KEY" };
  const [body, sig] = k.split(".");
  if (!body || !sig) return { pro: false, reason: "LICENSE_KEY is malformed" };
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    ok = crypto.verify(null, Buffer.from(body), pub, Buffer.from(sig, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { pro: false, reason: "LICENSE_KEY signature is invalid" };
  let lic: License;
  try {
    lic = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as License;
  } catch {
    return { pro: false, reason: "LICENSE_KEY is malformed" };
  }
  if (!products.includes(lic.product)) return { pro: false, reason: `LICENSE_KEY is for ${lic.product}, not this bot` };
  return { pro: true, license: lic };
}

export const proOnly = (what: string) => `🔒 ${what} is part of ${PRO_NAME}. Get a key at ${BUY_URL}, put it in .env as LICENSE_KEY and restart.`;
