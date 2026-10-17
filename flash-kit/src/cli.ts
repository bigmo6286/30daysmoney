/**
 * flash-kit: Morpho flash liquidity + two-pool Uniswap v3 arbitrage.
 *
 *   flash-kit chains            (or --chain custom with CUSTOM_* + RPC_URL_CUSTOM in .env)
 *   flash-kit liquidity --chain base [--token 0x… (default WETH)]
 *   flash-kit quote     --chain base --mid 0xTOKEN --amount 1 --buy-fee 500 --sell-fee 3000
 *   flash-kit scan      --chain base --mid 0xTOKEN [--min 0.1] [--max 10]
 *   flash-kit deploy    --chain base --yes
 *   flash-kit arb       --chain base --executor 0x… --mid 0xTOKEN [--min-profit 0.001] [--slippage-bps 50] [--exec --yes] [--every 30]
 *   flash-kit allow-router --chain base --executor 0x… --router 0x… [--off] --yes
 *
 * The loan token is WETH unless --token is given. Keys come only from PRIVATE_KEY in the
 * environment / .env, never from arguments. Nothing is sent without --yes, and `arb` only
 * sends after a successful simulation.
 */
import { ethers } from "ethers";
import { CHAINS, flashLiquidity, loadArtifact, netOfGas, quote, routeFrom, scan, simulate, tokenInfo, type ChainCfg, type Quote } from "./arb";

export function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string | true> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[k] = next;
      i++;
    } else opts[k] = true;
  }
  if ("private-key" in opts || "key" in opts) throw new Error("never pass keys as arguments (they end up in shell history); set PRIVATE_KEY in .env");
  return { cmd, opts };
}

export function chainFrom(opts: Record<string, string | true>, env: NodeJS.ProcessEnv = process.env): ChainCfg {
  const key = String(opts.chain ?? "");
  if (key === "custom") {
    const need = (k: string) => {
      const v = (env[k] || "").trim();
      if (!v) throw new Error(`--chain custom needs ${k}`);
      return v;
    };
    return {
      name: env.CUSTOM_NAME || "custom",
      chainId: Number(need("CUSTOM_CHAIN_ID")),
      rpcUrl: need("RPC_URL_CUSTOM"),
      morpho: need("CUSTOM_MORPHO"),
      swapRouter02: need("CUSTOM_ROUTER"),
      quoterV2: need("CUSTOM_QUOTER"),
      factory: need("CUSTOM_FACTORY"),
      weth: need("CUSTOM_WETH"),
    };
  }
  const base = CHAINS[key];
  if (!base) throw new Error(`--chain must be one of: ${Object.keys(CHAINS).join(", ")}, custom`);
  const alchemyKey = (env.ALCHEMY_KEY || "").trim();
  const alchemy = alchemyKey && base.alchemy ? `https://${base.alchemy}.g.alchemy.com/v2/${alchemyKey}` : "";
  return { ...base, rpcUrl: env[`RPC_URL_${key.toUpperCase()}`] || alchemy || base.rpcUrl };
}

const addr = (v: unknown, what: string) => {
  if (typeof v !== "string" || !ethers.isAddress(v)) throw new Error(`${what} must be a 0x address`);
  return ethers.getAddress(v);
};

function wallet(provider: ethers.Provider): ethers.Wallet {
  const k = (process.env.PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("PRIVATE_KEY (0x + 64 hex) is required in the environment for this command. Use a dedicated wallet.");
  return new ethers.Wallet(k, provider);
}

function requireYes(opts: Record<string, string | true>, what: string) {
  if (opts.yes !== true) throw new Error(`${what} sends a transaction: re-run with --yes once you've read the plan above`);
}

const fmt = (v: bigint, dec: number, dp = 6) => {
  const s = ethers.formatUnits(v < 0n ? -v : v, dec);
  const [w, f = ""] = s.split(".");
  const t = f.slice(0, dp).replace(/0+$/, "");
  return `${v < 0n ? "-" : ""}${w}${t ? "." + t : ""}`;
};

function showQuote(q: Quote, loanSym: string, dec: number) {
  return `buy ${q.buy.fee / 10_000}% → sell ${q.sell.fee / 10_000}% · borrow ${fmt(q.amount, dec)} ${loanSym} · back ${fmt(q.back, dec)} · gross ${q.gross >= 0n ? "+" : ""}${fmt(q.gross, dec)} ${loanSym}`;
}

async function main(argv: string[], log = console.log) {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === "help" || opts.help) {
    log((await import("node:fs")).readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^ \* ?/, "")).join("\n"));
    return;
  }
  if (cmd === "chains") {
    for (const [k, c] of Object.entries(CHAINS)) log(`${k.padEnd(10)} ${c.name} (${c.chainId}) · Morpho ${c.morpho} · router ${c.swapRouter02}`);
    return;
  }
  const chain = chainFrom(opts);
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  const loan = opts.token ? addr(opts.token, "--token") : ethers.getAddress(chain.weth);
  const loanInfo = await tokenInfo(provider, loan);

  switch (cmd) {
    case "liquidity": {
      const l = await flashLiquidity(provider, chain, loan);
      log(`${chain.name}: Morpho can flash-lend up to ${fmt(l, loanInfo.decimals)} ${loanInfo.symbol} (fee 0)`);
      return;
    }
    case "quote": {
      const mid = addr(opts.mid, "--mid");
      const q = await quote(provider, chain, {
        loanToken: loan,
        midToken: mid,
        amount: ethers.parseUnits(String(opts.amount ?? "1"), loanInfo.decimals),
        buyFee: Number(opts["buy-fee"] ?? 500),
        sellFee: Number(opts["sell-fee"] ?? 3000),
      });
      log(q ? showQuote(q, loanInfo.symbol, loanInfo.decimals) : "no route (a pool is missing or empty at one of those fee tiers)");
      return;
    }
    case "scan": {
      const mid = addr(opts.mid, "--mid");
      const found = await scan(provider, chain, loan, mid, ethers.parseUnits(String(opts.min ?? "0.1"), loanInfo.decimals), ethers.parseUnits(String(opts.max ?? "10"), loanInfo.decimals));
      if (!found.length) return log("no two pools for this pair on different fee tiers");
      for (const q of found.slice(0, 10)) log(showQuote(q, loanInfo.symbol, loanInfo.decimals));
      return;
    }
    case "deploy": {
      const w = wallet(provider);
      const art = loadArtifact();
      log(`Deploy FlashArb on ${chain.name} from ${w.address}\n  Morpho ${chain.morpho}\n  allowed router ${chain.swapRouter02}\n  owner (only caller, receives profit) ${w.address}`);
      requireYes(opts, "deploy");
      const c = await new ethers.ContractFactory(art.abi as ethers.InterfaceAbi, art.bytecode, w).deploy(chain.morpho, [chain.swapRouter02]);
      await c.waitForDeployment();
      log(`deployed: ${await c.getAddress()}`);
      return;
    }
    case "allow-router": {
      const w = wallet(provider);
      const ex = new ethers.Contract(addr(opts.executor, "--executor"), loadArtifact().abi as ethers.InterfaceAbi, w);
      const router = addr(opts.router, "--router");
      const on = opts.off !== true;
      log(`${on ? "Allow" : "Remove"} router ${router} on executor ${await ex.getAddress()}`);
      requireYes(opts, "allow-router");
      await (await ex.getFunction("setRouter")(router, on)).wait();
      log("done");
      return;
    }
    case "arb": {
      const mid = addr(opts.mid, "--mid");
      const exAddr = addr(opts.executor, "--executor");
      const w = wallet(provider);
      const ex = new ethers.Contract(exAddr, loadArtifact().abi as ethers.InterfaceAbi, w);
      const owner: string = await ex.getFunction("owner")();
      if (owner.toLowerCase() !== w.address.toLowerCase()) throw new Error(`PRIVATE_KEY is ${w.address}, but the executor's owner is ${owner}`);
      const minProfit = ethers.parseUnits(String(opts["min-profit"] ?? "0"), loanInfo.decimals);
      const slip = Number(opts["slippage-bps"] ?? 50);
      const every = Number(opts.every ?? 0);
      const liquidity = await flashLiquidity(provider, chain, loan);
      const max = ethers.parseUnits(String(opts.max ?? "10"), loanInfo.decimals);
      const once = async () => {
        const best = (await scan(provider, chain, loan, mid, ethers.parseUnits(String(opts.min ?? "0.1"), loanInfo.decimals), max < liquidity ? max : liquidity))[0];
        if (!best || best.gross <= 0n) return log(`${new Date().toISOString()} no profitable route`);
        log(`${new Date().toISOString()} best: ${showQuote(best, loanInfo.symbol, loanInfo.decimals)}`);
        const block = await provider.getBlock("latest");
        // first pass: what does it cost? then require profit ≥ your minimum + that gas, on-chain
        const probe = await simulate(ex, owner, routeFrom(best, 0n, slip, block!.timestamp));
        if (!probe.ok) return log(`  simulation reverts: ${probe.reason}`);
        const gasPrice = (await provider.getFeeData()).gasPrice ?? 0n;
        const gasCost = probe.gas! * gasPrice;
        const isWeth = loan.toLowerCase() === chain.weth.toLowerCase();
        const net = netOfGas(probe.profit!, probe.gas!, gasPrice, isWeth);
        log(`  simulated profit ${fmt(probe.profit!, loanInfo.decimals)} · gas ${probe.gas} × ${ethers.formatUnits(gasPrice, "gwei")} gwei = ${fmt(gasCost, 18)} ETH${net !== null ? ` · net ${fmt(net, 18)} ETH` : ""}`);
        const floor = minProfit + (isWeth ? gasCost : 0n);
        if (probe.profit! < floor) return log(`  below your floor (${fmt(floor, loanInfo.decimals)}): skipped`);
        const route = routeFrom(best, floor, slip, block!.timestamp);
        const final = await simulate(ex, owner, route);
        if (!final.ok) return log(`  final simulation reverts: ${final.reason}`);
        if (opts.exec !== true) return log("  dry run: add --exec --yes to send");
        requireYes(opts, "arb --exec");
        const rc = await (await ex.getFunction("execute")(route, { gasLimit: (final.gas! * 12n) / 10n })).wait();
        log(`  sent ${rc?.hash} · status ${rc?.status === 1 ? "ok" : "reverted"}`);
      };
      await once();
      while (every > 0) {
        await new Promise((r) => setTimeout(r, every * 1000));
        await once().catch((e) => log(`  error: ${(e as Error).message}`));
      }
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}" (try: flash-kit help)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`flash-kit: ${(e as Error).message}`);
    process.exit(1);
  });
}

export { main };
