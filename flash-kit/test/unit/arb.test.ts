import { describe, expect, it } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { failureNote, findRoute, MAX_ACCOUNTS, roundTripStrategy, RouteTooLargeError, stageOf } from "../../src/sol/arb";
import { transfersInto } from "../../src/sol/kamino";

const q = (out: bigint, maxAccounts: number) => ({ outAmount: out, minOut: out, labels: ["Venue"], route: "Venue", maxAccounts });
/** a fake Jupiter that records the account cap of every quote */
const jupiter = (caps: number[]) =>
  ({
    quote: async (_i: string, _o: string, amount: bigint, _s: number, _x: string[], maxAccounts: number) => {
      caps.push(maxAccounts);
      return q(amount + 1_000n, maxAccounts);
    },
  }) as never;
const r = { mint: Keypair.generate().publicKey } as never;
const payer = Keypair.generate().publicKey;
const ok = (trip: unknown) => ({ tx: {} as never, built: { ok: true, delta: 10n, logs: [], trip } as never });

describe("findRoute", () => {
  it("re-quotes with a smaller account cap when the route doesn't fit, until one does", async () => {
    const caps: number[] = [];
    let builds = 0;
    const build = (async (_c: unknown, _j: unknown, _r: unknown, _p: unknown, trip: { buy: { maxAccounts: number } }) => {
      builds++;
      if (trip.buy.maxAccounts > 12) throw new RouteTooLargeError();
      return ok(trip);
    }) as never;
    const found = await findRoute({} as never, jupiter(caps), r, payer, "MID", 1_000_000n, 20n, 30, 4, build);
    expect(found?.built.ok).toBe(true);
    expect(found?.maxAccounts).toBe(12);
    expect(builds).toBe(3);
    expect(caps).toEqual([24, 24, 16, 16, 12, 12]); // buy and sell leg at each cap
  });

  it("gives up with the size error once the smallest cap is too large too", async () => {
    const build = (async () => {
      throw new RouteTooLargeError();
    }) as never;
    await expect(findRoute({} as never, jupiter([]), r, payer, "MID", 1_000_000n, 20n, 30, 4, build)).rejects.toBeInstanceOf(RouteTooLargeError);
  });

  it("doesn't touch the cap when the route fits", async () => {
    const caps: number[] = [];
    const found = await findRoute({} as never, jupiter(caps), r, payer, "MID", 1_000_000n, 20n, 30, 4, (async (...a: unknown[]) => ok(a[4])) as never);
    expect(found?.maxAccounts).toBe(MAX_ACCOUNTS[0]);
    expect(caps).toEqual([24, 24]);
  });

  it("rethrows other build errors", async () => {
    const build = (async () => {
      throw new Error("rpc down");
    }) as never;
    await expect(findRoute({} as never, jupiter([]), r, payer, "MID", 1_000_000n, 20n, 30, 4, build)).rejects.toThrow("rpc down");
  });
});

describe("roundTripStrategy", () => {
  const ix = (tag: string) => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from(tag) });
  const legs = (ledger: boolean) => {
    const buy = { setup: [ix("buy-setup")], swap: ix("buy-swap"), cleanup: [ix("buy-cleanup")], instructions: [], lookupTables: [] };
    const sell = { setup: [ix("sell-setup")], swap: ix("sell-swap"), cleanup: [], ...(ledger ? { tokenLedger: ix("ledger") } : {}), instructions: [], lookupTables: [] };
    return { buy, sell };
  };

  it("records the ledger after the buy's setup and before its swap, so the sell spends what the buy delivered", () => {
    const { buy, sell } = legs(true);
    expect(roundTripStrategy(buy, sell).map((i) => i.data.toString())).toEqual(["buy-setup", "ledger", "buy-swap", "buy-cleanup", "sell-setup", "sell-swap"]);
  });

  it("refuses a sell leg without a ledger (a fixed-size sell fails when the buy fills a little short)", () => {
    const { buy, sell } = legs(false);
    expect(() => roundTripStrategy(buy, sell)).toThrow(/token ledger/);
  });
});

describe("stageOf", () => {
  // 3 setup ixs, borrow at 3, 4 buy-side ixs (4-7), 2 sell-side (8-9), repay at 10: 11 in all
  it("names each step of the flash transaction", () => {
    expect([0, 2, 3, 4, 7, 8, 9, 10].map((i) => stageOf(i, 3, 4, 11))).toEqual(["setup", "setup", "borrow", "buy", "buy", "sell", "sell", "repay"]);
  });
});

describe("failureNote", () => {
  const trip = { amount: 2_000_000_000n } as never;
  const units = (raw: bigint) => `${Number(raw) / 1e6} USDC`;
  it("says how far short the swaps came back when the repay fails", () => {
    expect(failureNote({ stage: "repay", returned: 1_998_100_000n, error: "insufficient funds", trip }, 40_000n, units)).toBe("failed at repay: swaps returned 1998.1 USDC of 2000.04 USDC owed (−1.94 USDC)");
  });
  it("falls back to the error for other steps", () => {
    expect(failureNote({ stage: "sell", error: "Error Message: InsufficientFunds", trip }, 0n, units)).toBe("failed at sell: Error Message: InsufficientFunds");
    expect(failureNote({ error: "boom", trip }, 0n, units)).toBe("failed: boom");
  });
});

describe("transfersInto", () => {
  const t = (destination: string, amount: string, type = "transfer") => ({ parsed: { type, info: { destination, amount } } });
  it("sums transfers into the account between the borrow and the repay only", () => {
    const inner = [
      { index: 3, instructions: [t("ATA", "2000")] }, // the borrow itself
      { index: 6, instructions: [t("ATA", "1500"), t("OTHER", "9")] },
      { index: 9, instructions: [{ parsed: { type: "transferChecked", info: { destination: "ATA", tokenAmount: { amount: "498" } } } }] },
      { index: 10, instructions: [t("ATA", "7")] }, // the repay
    ];
    expect(transfersInto(inner, "ATA", 3, 10)).toBe(1998n);
  });
});
