import { describe, expect, it } from "vitest";
import { alertText, changes, runAlerts, snapshot, type WalletState } from "../../src/alerts";
import type { Row } from "../../src/model";

const row = (id: string, inRange: boolean | undefined, o: Partial<Row> = {}): Row => ({ source: "wallet", chain: "Robinhood Chain", wallet: "0xa", id, pair: `P${id}/USDG`, status: "open", unit: "USD", valueNative: 1, inRange, ...o }) as Row;
const W = "0xe5a3c204d05677f40be079d1a596f068a2c6c258";
const MIN = 60_000;

describe("range alerts", () => {
  it("snapshot keeps open positions with a known range state", () => {
    expect(Object.keys(snapshot([row("1", true), row("2", undefined), row("3", false, { status: "closed" })]))).toEqual(["Robinhood Chain|1"]);
  });

  it("changes: only flips on positions seen before; first read, new and closed positions are silent", () => {
    const prev: WalletState = { at: 0, pos: snapshot([row("1", true), row("2", false), row("gone", true)]) };
    const now = snapshot([row("1", false), row("2", true), row("new", false)]);
    expect(changes(undefined, now)).toEqual([]);
    expect(changes(prev, now)).toEqual([
      { inRange: false, label: "P1/USDG on Robinhood Chain" },
      { inRange: true, label: "P2/USDG on Robinhood Chain" },
    ]);
  });

  it("alert text escapes token symbols and names the wallet briefly", () => {
    const t = alertText(W, { label: "<b>X</b>&Y/USDG on Base", inRange: false }, "https://s/dashboard/");
    expect(t).toContain("&lt;b>X&lt;/b>&amp;Y");
    expect(t).toContain("0xe5a3…c258");
    expect(t).toContain("Out of range");
    expect(t.endsWith("https://s/dashboard/")).toBe(true);
  });

  it("a run: records first, alerts every watcher of a wallet on a flip, respects the 15-min cadence, skips failed reads", async () => {
    let inRange = true;
    let fail = false;
    let reads = 0;
    const read = async () => {
      reads++;
      if (fail) throw new Error("rpc down");
      return [row("1", inRange)];
    };
    const watches = [{ chatId: 1, address: W.toUpperCase().replace("0X", "0x") }, { chatId: 2, address: W }];
    let r = await runAlerts(watches, {}, read, 0);
    expect(r.alerts).toEqual([]);
    expect(reads).toBe(1); // one read per wallet, however many watchers
    inRange = false;
    r = await runAlerts(watches, r.state, read, 5 * MIN);
    expect(reads).toBe(1); // not due yet
    r = await runAlerts(watches, r.state, read, 16 * MIN);
    expect(r.alerts.map((a) => a.chatId)).toEqual([1, 2]);
    expect(r.alerts[0]!.text).toContain("Out of range");
    // a failed read changes nothing, and is retried next run
    inRange = true;
    fail = true;
    const before = r.state;
    r = await runAlerts(watches, r.state, read, 40 * MIN);
    expect(r.failed).toEqual([W]);
    expect(r.state).toEqual(before);
    fail = false;
    r = await runAlerts(watches, r.state, read, 41 * MIN);
    expect(r.alerts[0]!.text).toContain("Back in range");
    // nobody watching any more: state dropped
    expect((await runAlerts([], r.state, read, 60 * MIN)).state).toEqual({});
  });
});
