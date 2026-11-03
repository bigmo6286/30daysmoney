import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { findRoute, MAX_ACCOUNTS, RouteTooLargeError } from "../../src/sol/arb";

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
