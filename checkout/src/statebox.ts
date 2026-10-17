/**
 * The shop's data directory (orders with buyer chat ids and license keys, watcher cursors) packed
 * into one AES-256-GCM file, so a scheduled GitHub Action can keep it in the Actions cache.
 * Caches can be restored by workflows from forks, which never get secrets: without the key the
 * file is noise. The key is derived from LICENSE_PRIVATE_KEY, so there is no extra secret to keep.
 *
 *   npm run state -- pack   <dataDir> <file>
 *   npm run state -- unpack <file> <dataDir>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("30dmS1");

export function stateKey(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret.trim()), Buffer.from("30daysmoney"), Buffer.from("shop-state v1"), 32));
}

export function seal(files: Record<string, string>, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(files), "utf8"), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

export function open(blob: Buffer, key: Buffer): Record<string, string> {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a shop state file");
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]).toString("utf8"));
}

/** flat directories only: the shop's data dir has no subfolders */
export function packDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) out[f] = fs.readFileSync(p, "utf8");
  }
  return out;
}

export function unpackDir(files: Record<string, string>, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    if (f !== path.basename(f)) throw new Error(`bad file name in state: ${f}`);
    fs.writeFileSync(path.join(dir, f), body);
  }
}

if (process.argv[1] && /statebox\.[jt]s$/.test(process.argv[1])) {
  const [cmd, a, b] = process.argv.slice(2);
  const secret = process.env.LICENSE_PRIVATE_KEY || "";
  if (!secret) throw new Error("LICENSE_PRIVATE_KEY is required");
  const key = stateKey(secret);
  if (cmd === "pack" && a && b) fs.writeFileSync(b, seal(packDir(a), key));
  else if (cmd === "unpack" && a && b) {
    if (fs.existsSync(a)) unpackDir(open(fs.readFileSync(a), key), b);
    else console.log("no saved state yet: starting fresh");
  } else throw new Error("usage: statebox pack <dir> <file> | unpack <file> <dir>");
}
