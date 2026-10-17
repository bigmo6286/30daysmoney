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
