/** One-time: create the license signing key pair. */
import { generateKeys } from "./license";

const k = generateKeys();
console.log("Add to .env (keep it secret, back it up):\n");
console.log(`LICENSE_PRIVATE_KEY=${k.privateKey}\n`);
console.log("Public key (safe to publish; verifies licenses):\n");
console.log(k.publicKey);
