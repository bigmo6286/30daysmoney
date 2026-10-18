/**
 * License keys: base64url(JSON payload) + "." + base64url(ed25519 signature).
 * Anyone with the public key can verify a key offline; only the server can issue one.
 */
import crypto from "node:crypto";

export interface LicensePayload {
  order: string;
  product: string;
  contact: string;
  /** ms since epoch */
  issued: number;
  /** ms since epoch; absent = never expires */
  expires?: number;
}

const DAY_MS = 86_400_000;

/** What a key says, without checking it (for keys we issued ourselves). */
export function readPayload(license: string): LicensePayload | null {
  try {
    return JSON.parse(Buffer.from(license.split(".")[0] ?? "", "base64url").toString("utf8")) as LicensePayload;
  } catch {
    return null;
  }
}

/**
 * The payload for a paid order. A subscription (`days`) runs from now, or from the end of the
 * buyer's latest still-running key for the same product (`earlier`), so renewing early loses nothing.
 */
export function payloadFor(o: { id: string; product: string; contact: string }, days: number | undefined, earlier: string[] = [], now = Date.now()): LicensePayload {
  const p: LicensePayload = { order: o.id, product: o.product, contact: o.contact, issued: now };
  if (!days) return p;
  const running = Math.max(now, ...earlier.map((k) => readPayload(k)).filter((e): e is LicensePayload => e?.product === o.product).map((e) => e.expires ?? 0));
  return { ...p, expires: running + days * DAY_MS };
}

export function generateKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

const priv = (b64: string) => crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
const pub = (b64: string) => crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

export function publicKeyOf(privateKey: string): string {
  return crypto.createPublicKey(priv(privateKey)).export({ type: "spki", format: "der" }).toString("base64");
}

export function issue(p: LicensePayload, privateKey: string): string {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(body), priv(privateKey)).toString("base64url");
  return `${body}.${sig}`;
}

export function verify(license: string, publicKey: string): LicensePayload | null {
  const [body, sig] = license.trim().split(".");
  if (!body || !sig) return null;
  try {
    if (!crypto.verify(null, Buffer.from(body), pub(publicKey), Buffer.from(sig, "base64url"))) return null;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LicensePayload;
  } catch {
    return null;
  }
}

/** the buyer behind an order's contact: "tg:<chat> @handle" is the chat (handles change), else the contact as given */
const buyerOf = (contact: string) => contact.split(" ")[0]!.toLowerCase();

/** The license key for a paid order, extending the same buyer's running subscription if they have one. */
// structural, not imported: the bots' tests import this file without checkout's dependencies
type Paid = { id: string; product: string; contact: string; license?: string };

export function issueFor(o: Paid, products: { id: string; days?: number }[], orders: Paid[], privateKey: string, now = Date.now()): string {
  const earlier = orders.filter((x) => x.id !== o.id && x.license && x.product === o.product && buyerOf(x.contact) === buyerOf(o.contact)).map((x) => x.license!);
  return issue(payloadFor(o, products.find((p) => p.id === o.product)?.days, earlier, now), privateKey);
}
