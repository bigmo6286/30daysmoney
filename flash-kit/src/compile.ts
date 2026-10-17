/** solc-js compile of the executor; deterministic settings so the committed artifact can be re-checked. */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

export interface Artifact {
  contract: string;
  compiler: string;
  sourceHash: string;
  abi: unknown[];
  bytecode: string;
}

export const SOURCE_FILE = new URL("../contracts/FlashArb.sol", import.meta.url);

export function compileFlashArb(): Artifact {
  const solc = createRequire(import.meta.url)("solc");
  const source = fs.readFileSync(SOURCE_FILE, "utf8");
  const input = {
    language: "Solidity",
    sources: { "FlashArb.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts["FlashArb.sol"].FlashArb;
  return {
    contract: "FlashArb",
    compiler: solc.version(),
    sourceHash: crypto.createHash("sha256").update(source).digest("hex"),
    abi: c.abi,
    bytecode: "0x" + c.evm.bytecode.object,
  };
}
