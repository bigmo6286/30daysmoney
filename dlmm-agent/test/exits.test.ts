import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config";
import { exitReason, type ExitSnapshot } from "../src/exits";

const s = SettingsSchema.parse({});
const base: ExitSnapshot = { ageMin: 60, pnlPct: 1, peakPnlPct: 1, range: "in", oorMin: 0, feeTvlPct: 1 };

describe("exits", () => {
  it("holds a healthy position", () => {
    expect(exitReason(base, s)).toBeNull();
  });
  it("stop loss fires at any age and any depth (a −90% rug is still cut)", () => {
    expect(exitReason({ ...base, ageMin: 0.5, pnlPct: -16 }, s)).toMatch(/stop loss/);
    expect(exitReason({ ...base, pnlPct: -92 }, s)).toMatch(/stop loss/);
    expect(exitReason({ ...base, pnlPct: -92 }, { ...s, stopLossPct: 0 })).toBeNull();
  });
  it("nothing but the stop loss before minAgeMin", () => {
    expect(exitReason({ ...base, ageMin: 2, range: "below", oorMin: 999 }, s)).toBeNull();
  });
  it("take profit and trailing take profit", () => {
    expect(exitReason({ ...base, pnlPct: 12 }, { ...s, takeProfitPct: 10 })).toMatch(/take profit/);
    expect(exitReason({ ...base, pnlPct: 4, peakPnlPct: 8 }, s)).toMatch(/trailing/);
    expect(exitReason({ ...base, pnlPct: 4, peakPnlPct: 6 }, s)).toBeNull(); // 2% off the peak < 3%
    expect(exitReason({ ...base, pnlPct: 1, peakPnlPct: 4 }, s)).toBeNull(); // never armed
  });
  it("out of range timers per side", () => {
    expect(exitReason({ ...base, range: "above", oorMin: 16 }, s)).toMatch(/above range/);
    expect(exitReason({ ...base, range: "above", oorMin: 10 }, s)).toBeNull();
    expect(exitReason({ ...base, range: "below", oorMin: 20 }, s)).toBeNull();
    expect(exitReason({ ...base, range: "below", oorMin: 31 }, s)).toMatch(/below range/);
  });
  it("faded yield after the grace period, unknown yield never closes", () => {
    expect(exitReason({ ...base, feeTvlPct: 0.01 }, s)).toMatch(/yield faded/);
    expect(exitReason({ ...base, ageMin: 30, feeTvlPct: 0.01 }, s)).toBeNull();
    expect(exitReason({ ...base, feeTvlPct: undefined }, s)).toBeNull();
  });
});
