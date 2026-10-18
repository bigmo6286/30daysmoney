import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeReserve, flashInstructions, KLEND, marketAuthority, RESERVE_DISC, type Reserve } from "../../src/sol/kamino";
import { base58, solKeypair } from "../../src/sol/cli";

const d8 = (s: string) => crypto.createHash("sha256").update(s).digest().subarray(0, 8);
const market = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const r: Reserve = {
  address: new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  market,
  mint,
  supplyVault: Keypair.generate().publicKey,
  feeVault: Keypair.generate().publicKey,
  marketAuthority: marketAuthority(market),
  tokenProgram: TOKEN_PROGRAM_ID,
  decimals: 6,
};

describe("kamino instructions", () => {
  const payer = Keypair.generate().publicKey;
  const ixs = flashInstructions({ payer, reserve: r, amount: 1_000_000_000n, strategy: [] });

  it("compute budget, ATA, borrow, (strategy), repay; repay points back at the borrow", () => {
    expect(ixs).toHaveLength(5);
    const [, , , borrow, repay] = ixs;
    expect(borrow!.programId.equals(KLEND)).toBe(true);
    expect(borrow!.data.subarray(0, 8)).toEqual(d8("global:flash_borrow_reserve_liquidity"));
    expect(borrow!.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(repay!.data.subarray(0, 8)).toEqual(d8("global:flash_repay_reserve_liquidity"));
    expect(repay!.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(repay!.data[16]).toBe(3); // the borrow's index in the transaction
  });

  it("accounts in klend's order, only the payer signs, vaults and reserve writable", () => {
    const k = ixs[3]!.keys;
    const ata = getAssociatedTokenAddressSync(mint, payer, true);
    expect(k.map((a) => a.pubkey.toBase58())).toEqual(
      [payer, r.marketAuthority, market, r.address, mint, r.supplyVault, ata, r.feeVault, KLEND, KLEND, SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID].map((p) => p.toBase58()),
    );
    expect(k.filter((a) => a.isSigner).map((a) => a.pubkey.toBase58())).toEqual([payer.toBase58()]);
    expect(k.filter((a) => a.isWritable).map((a) => a.pubkey.toBase58())).toEqual([r.address, r.supplyVault, ata, r.feeVault].map((p) => p.toBase58()));
  });

  it("market authority is klend's lma PDA (matches mainnet)", () => {
    expect(marketAuthority(market).toBase58()).toBe("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");
  });

  it("refuses accounts that aren't klend reserves", () => {
    const data = Buffer.alloc(300);
    RESERVE_DISC.copy(data);
    market.toBuffer().copy(data, 32);
    mint.toBuffer().copy(data, 128);
    expect(decodeReserve(r.address, KLEND, data).mint.equals(mint)).toBe(true);
    expect(() => decodeReserve(r.address, TOKEN_PROGRAM_ID, data)).toThrow(/isn't a Kamino Lend account/);
    expect(() => decodeReserve(r.address, KLEND, Buffer.alloc(300))).toThrow(/isn't a Kamino reserve/);
  });
});

describe("solana keys", () => {
  it("reads SOL_PRIVATE_KEY as a JSON byte array or base58, and never without it", () => {
    const kp = Keypair.generate();
    expect(solKeypair({ SOL_PRIVATE_KEY: JSON.stringify([...kp.secretKey]) }).publicKey.equals(kp.publicKey)).toBe(true);
    expect(base58(kp.publicKey.toBase58())).toEqual(kp.publicKey.toBytes());
    expect(base58("11")).toEqual(Uint8Array.from([0, 0]));
    expect(() => solKeypair({})).toThrow(/SOL_PRIVATE_KEY is required/);
    expect(() => base58("0OIl")).toThrow(/base58/);
  });
});
