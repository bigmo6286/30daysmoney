import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// the seller side: keys come from checkout/, so check against its real issuer
import { generateKeys, issue } from "../../checkout/src/license";
import { checkLicense, LICENSE_PUBLIC_KEY } from "../src/license";
import { SettingsStore } from "../src/config";

const seller = generateKeys();
const key = (product = "dlmm-agent") => issue({ order: "ord1", product, contact: "@buyer", issued: 1 }, seller.privateKey);

describe("license", () => {
  it("accepts a key checkout issued for this bot, setup bundle included", () => {
    expect(checkLicense(key(), seller.publicKey)).toMatchObject({ pro: true, license: { order: "ord1", product: "dlmm-agent" } });
    expect(checkLicense(key("dlmm-agent-setup"), seller.publicKey).pro).toBe(true);
  });

  it("refuses missing, malformed, forged, tampered and other-product keys", () => {
    expect(checkLicense("", seller.publicKey)).toEqual({ pro: false, reason: "no LICENSE_KEY" });
    expect(checkLicense("nonsense", seller.publicKey).pro).toBe(false);
    const forger = generateKeys();
    expect(checkLicense(issue({ order: "x", product: "dlmm-agent", contact: "", issued: 1 }, forger.privateKey), seller.publicKey).pro).toBe(false);
    const [body, sig] = key().split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), order: "free" })).toString("base64url");
    expect(checkLicense(`${edited}.${sig}`, seller.publicKey).pro).toBe(false);
    expect(checkLicense(key("lp-bot"), seller.publicKey)).toMatchObject({ pro: false, reason: expect.stringMatching(/not this bot/) });
    // and the shipped public key is not the test seller's
    expect(checkLicense(key(), LICENSE_PUBLIC_KEY).pro).toBe(false);
  });

  it("free tier: Pro settings read as off and can't be turned on; everything else works", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lic-"));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ autoEnabled: true }));
    const free = new SettingsStore(dir, false);
    expect(free.value.autoEnabled).toBe(false); // saved on, but locked without a license
    expect(() => free.set("autoEnabled", "on")).toThrow(/Pro.*LICENSE_KEY/);
    expect(() => free.set("dailyReport", "on")).toThrow(/Pro/);
    expect(free.set("autoEnabled", "off")).toBe(false);
    expect(new SettingsStore(dir, true).value.autoEnabled).toBe(false); // the "off" was saved
    const pro = new SettingsStore(dir, true);
    expect(pro.set("autoEnabled", "on")).toBe(true);
    expect(new SettingsStore(dir, false).value.autoEnabled).toBe(false);
  });
});
