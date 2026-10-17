import { describe, expect, it } from "vitest";
import { JevScreener } from "../../src/auto/jev";
import { CachedScreener, screenVerdict, type Assessment, type Screener } from "../../src/auto/screen";
import type { TokenFacts } from "../../src/auto/facts";
import type { Candidate } from "../../src/auto/scanner";

const facts: TokenFacts = {
  address: "0x1111111111111111111111111111111111111111",
  name: "Pepe Two",
  symbol: "PEPE2",
  decimals: 18,
  totalSupply: "1000000000000000000000000",
  supplyInPoolPct: 42.5,
  owner: "0x2222222222222222222222222222222222222222",
  upgradeableProxy: false,
  codeSizeBytes: 9000,
  adminFunctions: ["mint(address,uint256)", "setTax(uint256)"],
};
const market: Candidate = {
  pool: "0x3333333333333333333333333333333333333333",
  token: facts.address,
  symbol: "PEPE2",
  fee: 10000,
  depthWei: 5n * 10n ** 18n,
  priceE18: 10n ** 12n,
  aprPct: 400,
  aprEmaPct: 350.4,
  movePct: 1.234,
  swaps: 12,
  samples: 3,
  updatedAt: 0,
};

const ok = (answers: unknown) => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: {} }), { status: 200 });
const answers = {
  copycat: { type: "noul", noul: 0.9 },
  rug_signs: { type: "noul", noul: 0.7 },
  risk: { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.8 },
};

describe("JevScreener", () => {
  it("sends one typed request and maps the answers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const jev = new JevScreener({
      apiKey: "k",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return ok(answers);
      }) as typeof fetch,
    });
    const a = await jev.assess(facts, market, ["WETH", "PEPE"]);
    expect(a).toEqual({ copycat: 0.9, rugSigns: 0.7, risk: 0.75, source: "jev-1.13.0" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state.token.adminFunctions).toContain("mint(address,uint256)");
    expect(body.state.market).toMatchObject({ fee_tier_pct: 1, weth_depth: 5, fee_apr_pct: 350 });
    expect(body.state.other_listed).toEqual(["WETH", "PEPE"]);
    expect(Object.keys(body.questions)).toEqual(["copycat", "rug_signs", "risk"]);
    expect(body.questions.risk.criteria).toHaveLength(5);
  });

  it("retries 429 and fails on other HTTP errors", async () => {
    let n = 0;
    const flaky = new JevScreener({
      apiKey: "k",
      fetch: (async () => (++n === 1 ? new Response("slow down", { status: 429 }) : ok(answers))) as typeof fetch,
    });
    await expect(flaky.assess(facts, market, [])).resolves.toMatchObject({ copycat: 0.9 });
    expect(n).toBe(2);

    let m = 0;
    const bad = new JevScreener({ apiKey: "k", fetch: (async () => (m++, new Response("nope", { status: 401 }))) as typeof fetch });
    await expect(bad.assess(facts, market, [])).rejects.toThrow("HTTP 401");
    expect(m).toBe(1);
  });

  it("rejects an answer missing a field", async () => {
    const jev = new JevScreener({ apiKey: "k", fetch: (async () => ok({ copycat: answers.copycat })) as typeof fetch });
    await expect(jev.assess(facts, market, [])).rejects.toThrow("rug_signs");
  });
});

describe("screen policy", () => {
  const a: Assessment = { copycat: 0.2, rugSigns: 0.3, risk: 0.5, source: "t" };
  const p = { maxCopycat: 0.5, maxRugSigns: 0.4, maxRisk: 0.6 };
  it("passes under every threshold, blocks on the first one exceeded", () => {
    expect(screenVerdict(a, p)).toEqual({ ok: true });
    expect(screenVerdict({ ...a, copycat: 0.8 }, p)).toEqual({ ok: false, reason: "copycat 80%" });
    expect(screenVerdict({ ...a, rugSigns: 0.41 }, p)).toEqual({ ok: false, reason: "rug signs 41%" });
    expect(screenVerdict({ ...a, risk: 0.9 }, p)).toEqual({ ok: false, reason: "risk 90%" });
  });

  it("caches per token", async () => {
    let n = 0;
    const inner: Screener = { name: "x", assess: async () => (n++, a) };
    const c = new CachedScreener(inner);
    await c.assess(facts, market, []);
    await c.assess({ ...facts, address: facts.address.toUpperCase().replace("0X", "0x") }, market, []);
    expect(n).toBe(1);
  });
});
