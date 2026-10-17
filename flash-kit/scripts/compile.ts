/** Compile contracts/FlashArb.sol with solc-js into artifacts/FlashArb.json (committed, checked by tests). */
import fs from "node:fs";
import { compileFlashArb } from "../src/compile";

const a = compileFlashArb();
fs.writeFileSync(new URL("../artifacts/FlashArb.json", import.meta.url), JSON.stringify(a, null, 2) + "\n");
console.log(`FlashArb: ${a.bytecode.length / 2 - 1} bytes, solc ${a.compiler}, source ${a.sourceHash.slice(0, 10)}`);
