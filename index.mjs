#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, appendFileSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fetchBounded } from "./bounded-fetch.mjs";
import { detectProxy, lookupBlockscoutProxy } from "./proxy-detection.mjs";
var __dirname = dirname(fileURLToPath(import.meta.url));

const isAction = !!process.env.GITHUB_ACTIONS;
function getInput(n) { return process.env["INPUT_" + n.toUpperCase().replace(/-/g, "_")] || ""; }
function setOutput(n, v) { if (isAction && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, n + "=" + v + "\n"); }
function die(m) { console.error(isAction ? "::error::" + m : "FAIL: " + m); process.exit(1); }
function info(m) { console.log("  " + m); }
function warn(m) { console.log("  ! " + m); }

const NETWORKS = {
  mainnet: { chainId: 1, rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://rpc.flashbots.net"] },
  sepolia: { chainId: 11155111, rpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia"] },
  polygon: { chainId: 137, rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://1rpc.io/matic"] },
  arbitrum: { chainId: 42161, rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://1rpc.io/arb"] },
  optimism: { chainId: 10, rpcs: ["https://optimism-rpc.publicnode.com", "https://1rpc.io/op"] },
  base: { chainId: 8453, rpcs: ["https://base-rpc.publicnode.com", "https://1rpc.io/base"] },
};
const BLOCKSCOUT = {
  1: "https://eth.blockscout.com",
  137: "https://polygon.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
  10: "https://optimism.blockscout.com",
  8453: "https://base.blockscout.com",
};
const SOURCE_TIMEOUT_MS = 15000;
const API_TIMEOUT_MS = 20000;
const COMPILER_TIMEOUT_MS = 60000;
function explainFetch(err) {
  var cause = err && err.cause;
  var detail = cause && (cause.code || cause.message);
  var msg = (err && err.message) || "request failed";
  return detail ? msg + " (" + detail + ")" : msg;
}

function rpcLabel(url) {
  try {
    var u = new URL(url);
    if (u.username || u.password || u.search) return u.origin + " (redacted)";
    return u.origin;
  } catch (e) {
    return "custom-rpc";
  }
}

async function rpcOnce(rpcUrl, method, params, fetchImpl) {
  var opened = await fetchBounded(rpcUrl, API_TIMEOUT_MS, fetchImpl || fetch, {
    read: "json",
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
    },
  });
  if (!opened.ok) throw new Error("HTTP " + opened.status);
  var d = opened.data;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("RPC: empty response");
  if (d.error) throw new Error("RPC: " + (d.error.message || d.error.code));
  if (!Object.prototype.hasOwnProperty.call(d, "result")) throw new Error("RPC: missing result");
  return d.result;
}

export function createRpc(urls, fetchImpl) {
  var list = urls.slice();
  var pinned = -1;
  return async function(method, params) {
    var order = [];
    if (pinned >= 0) order.push(pinned);
    for (var i = 0; i < list.length; i++) {
      if (i !== pinned) order.push(i);
    }
    var errors = [];
    for (var n = 0; n < order.length; n++) {
      var idx = order[n];
      try {
        var result = await rpcOnce(list[idx], method, params, fetchImpl);
        if (idx !== 0 && pinned !== idx) info("rpc=" + rpcLabel(list[idx]));
        pinned = idx;
        return result;
      } catch (e) {
        errors.push(rpcLabel(list[idx]) + " -> " + explainFetch(e));
      }
    }
    throw new Error("RPC failed: " + errors.join("; "));
  };
}

function sourcifyArtifact(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.runtimeMatch !== "exact_match" && data.runtimeMatch !== "match") return null;
  var compilation = data.compilation || {};
  var version = String(compilation.compilerVersion || "").replace(/^v/, "");
  var entries = Object.entries(data.sources || {});
  if (!version || !entries.length) return null;
  var sources = {};
  for (var i = 0; i < entries.length; i++) {
    var content = entries[i][1] && entries[i][1].content;
    if (typeof content !== "string" || content.length === 0) return null;
    sources[entries[i][0]] = { content: content };
  }
  var settings = compilation.compilerSettings || {};
  var opt = settings.optimizer || {};
  var cName = compilation.name || "";
  if (!cName && compilation.fullyQualifiedName) {
    var parts = String(compilation.fullyQualifiedName).split(":");
    cName = parts[parts.length - 1] || "";
  }
  return {
    provider: "sourcify", contractName: cName,
    compilerVersion: version,
    optimizationUsed: !!opt.enabled, runs: opt.runs || 200,
    evmVersion: settings.evmVersion || "default", sources: sources, settings: settings,
  };
}

async function trySourcify(chainId, address, fetchImpl = fetch, timeoutMs = SOURCE_TIMEOUT_MS) {
  var addr = address.toLowerCase();
  var url = "https://sourcify.dev/server/v2/contract/" + chainId + "/" + addr + "?fields=sources,compilation";
  try {
    var opened = await fetchBounded(url, timeoutMs, fetchImpl, { read: "json" });
    if (!opened.ok) {
      if (!opened.status || opened.status >= 500) info("Sourcify unavailable: HTTP " + opened.status);
      return null;
    }
    var artifact = sourcifyArtifact(opened.data);
    if (!artifact) info("Sourcify artifact is not a complete runtime match");
    return artifact;
  } catch (e) {
    info("Sourcify unavailable: " + explainFetch(e));
    return null;
  }
}

async function tryBlockscout(chainId, address, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS) {
  var base = BLOCKSCOUT[chainId];
  if (!base) return null;
  try {
    var url = base + "/api/v2/smart-contracts/" + address;
    var opened = await fetchBounded(url, timeoutMs, fetchImpl, { read: "json" });
    if (!opened.ok) return null;
    var d = opened.data || {};
    if (!d.source_code) return null;
    var name = d.name || "Contract";
    return {
      provider: "blockscout", contractName: name,
      compilerVersion: (d.compiler_version || "").replace(/^v/, ""),
      optimizationUsed: !!d.optimization_enabled,
      runs: d.optimization_runs || 200,
      evmVersion: d.evm_version || "default",
      sources: {}, settings: {},
      sourceCode: d.source_code,
    };
  } catch (e) {
    info("Blockscout unavailable: " + explainFetch(e));
    return null;
  }
}

async function tryEtherscan(chainId, address, apiKey, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS) {
  if (!apiKey) return null;
  try {
    var url = "https://api.etherscan.io/v2/api?chainid=" + chainId + "&module=contract&action=getsourcecode&address=" + address + "&apikey=" + apiKey;
    var opened = await fetchBounded(url, timeoutMs, fetchImpl, { read: "json" });
    if (!opened.ok) return null;
    var d = opened.data || {};
    var r0 = d.result && d.result[0];
    if (!r0 || !r0.SourceCode || !r0.ContractName) return null;
    var raw = r0.SourceCode;
    if (raw.startsWith("{{")) raw = raw.slice(1, -1);
    var sources, settings;
    try {
      var p = JSON.parse(raw);
      sources = p.sources || {};
      settings = p.settings || {};
    } catch (e2) {
      sources = {};
      settings = {};
    }
    return {
      provider: "etherscan", contractName: r0.ContractName,
      compilerVersion: r0.CompilerVersion.replace(/^v/, ""),
      optimizationUsed: r0.OptimizationUsed === "1",
      runs: parseInt(r0.Runs) || 200,
      evmVersion: r0.EVMVersion || "default",
      sources: sources, settings: settings,
      sourceCode: Object.keys(sources).length === 0 ? raw : null,
    };
  } catch (e) { return null; }
}

export async function loadVerifiedSource(chainId, address, etherscanKey, options) {
  var fetchImpl = (options && options.fetchImpl) || fetch;
  var sourcifyTimeoutMs = (options && options.sourcifyTimeoutMs) || SOURCE_TIMEOUT_MS;
  var blockscoutTimeoutMs = (options && options.blockscoutTimeoutMs) || API_TIMEOUT_MS;
  var src = await trySourcify(chainId, address, fetchImpl, sourcifyTimeoutMs);
  if (!src) { info("Trying Blockscout..."); src = await tryBlockscout(chainId, address, fetchImpl, blockscoutTimeoutMs); }
  if (!src && etherscanKey) { info("Trying Etherscan..."); src = await tryEtherscan(chainId, address, etherscanKey, fetchImpl); }
  return src;
}

async function downloadSolc(version) {
  var ver = version.split("+")[0];
  var dir = join(tmpdir(), "eth-deploy-verify");
  mkdirSync(dir, { recursive: true });
  var solcPath = join(dir, "soljson-" + ver + ".js");
  if (existsSync(solcPath)) { info("solc " + ver + " cached"); return solcPath; }
  info("Downloading solc-js " + ver + "...");
  var listUrl = "https://binaries.soliditylang.org/bin/list.json";
  var listOpened = await fetchBounded(listUrl, API_TIMEOUT_MS, fetch, { read: "json" });
  if (!listOpened.ok) throw new Error("HTTP " + listOpened.status + ": " + listUrl);
  var list = listOpened.data || {};
  var file = list.releases && list.releases[ver];
  if (!file) throw new Error("solc " + ver + " not in releases");
  var binaryUrl = "https://binaries.soliditylang.org/bin/" + file;
  var binaryOpened = await fetchBounded(binaryUrl, COMPILER_TIMEOUT_MS, fetch, { read: "buffer" });
  if (!binaryOpened.ok) throw new Error("solc download failed: " + binaryOpened.status);
  writeFileSync(solcPath, Buffer.from(binaryOpened.data));
  info("solc " + ver + " ready");
  return solcPath;
}

function buildStdInput(src) {
  var sources = src.sources;
  if (Object.keys(sources).length === 0 && src.sourceCode) {
    var fname = (src.contractName || "Contract") + ".sol";
    sources = {};
    sources[fname] = { content: src.sourceCode };
  }
  return {
    language: "Solidity",
    sources: sources,
    settings: {
      optimizer: { enabled: src.optimizationUsed, runs: src.runs },
      evmVersion: src.evmVersion !== "default" ? src.evmVersion : undefined,
      outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
    },
  };
}

function compileSolidity(solcPath, stdInput) {
  var dir = join(tmpdir(), "eth-deploy-verify");
  var wrapper = join(dir, "_compile.cjs");
  var escaped = solcPath.replace(/\\/g, "\\\\");
  var code =
    "var solc = require(\"solc\");\n" +
    "var soljson = require(\"" + escaped + "\");\n" +
    "var compiler = solc.setupMethods(soljson);\n" +
    "var inp = require(\"fs\").readFileSync(0, \"utf8\");\n" +
    "var out = compiler.compile(inp);\n" +
    "process.stdout.write(out);\n";
  writeFileSync(wrapper, code);
  var out;
  try {
    out = execSync("node \"" + wrapper + "\"", {
      input: JSON.stringify(stdInput), encoding: "utf-8",
      timeout: 120000, maxBuffer: 50 * 1024 * 1024,
      cwd: __dirname, stdio: ["pipe", "pipe", "ignore"],
      env: Object.assign({}, process.env, { NODE_PATH: join(__dirname, "node_modules") }),
    });
  } catch (e) {
    throw new Error("solc failed: " + (e.stdout || e.message || "").slice(0, 300));
  }
  var result = JSON.parse(out);
  if (result.errors) {
    var errs = result.errors.filter(function(e) { return e.severity === "error"; });
    if (errs.length) throw new Error("Compile errors:\n" + errs.map(function(e) { return e.formattedMessage || e.message; }).join("\n").slice(0, 500));
  }
  var all = [];
  for (var file in result.contracts || {}) {
    for (var name in result.contracts[file]) {
      var bc = result.contracts[file][name].evm;
      bc = bc && bc.deployedBytecode && bc.deployedBytecode.object;
      if (bc && bc.length > 2) all.push({ file: file, name: name, bytecode: "0x" + bc });
    }
  }
  if (!all.length) throw new Error("No bytecode in compilation output");
  return all;
}

function stripMeta(bytecode) {
  var hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  // solc >=0.5.9: CBOR length in last 2 bytes
  if (hex.length >= 4) {
    var metaLen = parseInt(hex.slice(-4), 16);
    if (metaLen > 0 && metaLen < 200 && metaLen * 2 + 4 <= hex.length) {
      return hex.slice(0, -(metaLen * 2 + 4));
    }
  }
  // solc 0.4.x: a165627a7a72305820...(64 hex chars)...0029
  hex = hex.replace(/a165627a7a72305820[0-9a-fA-F]{64}0029$/, "");
  return hex;
}

export function fingerprint(hex) {
  return createHash("sha256").update(String(hex)).digest("hex").slice(0, 16);
}

function pickBestMatch(onChainHex, candidates) {
  var onChain = stripMeta(onChainHex).toLowerCase();
  for (var i = 0; i < candidates.length; i++) {
    if (stripMeta(candidates[i].bytecode).toLowerCase() === onChain) {
      return { match: true, name: candidates[i].name, compiled: candidates[i].bytecode };
    }
  }
  candidates.sort(function(a, b) {
    return Math.abs(stripMeta(a.bytecode).length - onChain.length) - Math.abs(stripMeta(b.bytecode).length - onChain.length);
  });
  return { match: false, name: candidates[0].name, compiled: candidates[0].bytecode };
}

async function main() {
  var address = getInput("address") || process.argv[2] || "";
  var network = getInput("network") || process.argv[3] || "mainnet";
  var etherscanKey = getInput("etherscan-key") || process.argv[4] || process.env.ETHERSCAN_API_KEY || "";
  var blockscoutKey = getInput("blockscout-key") || process.env.BLOCKSCOUT_API_KEY || "";
  var rpcUrl = getInput("rpc-url") || process.argv[5] || "";
  if (!address) die("Missing address");
  var net = NETWORKS[network.toLowerCase()];
  if (!net) die("Unknown network: " + network);
  var rpc = createRpc(rpcUrl ? [rpcUrl] : net.rpcs);

  var sep = "========================================================";
  console.log("\n" + sep);
  console.log("  eth-deployment-verify");
  console.log(sep);
  info("Address: " + address);
  info("Network: " + network + " (chain " + net.chainId + ")");
  console.log(sep + "\n");

  try {
    info("Fetching verified source...");
    var src = await loadVerifiedSource(net.chainId, address, etherscanKey);
    if (!src) die("Source not found on any provider. Is contract verified?");
    info("provider=" + src.provider + " contract=" + src.contractName + " solc=" + src.compilerVersion);
    var optStr = src.optimizationUsed ? "on(" + src.runs + ")" : "off";
    info("optimizer=" + optStr + " evm=" + src.evmVersion);

    info("Fetching on-chain bytecode...");
    var onChain = await rpc("eth_getCode", [address, "latest"]);
    if (!onChain || onChain === "0x") die("No bytecode at address");
    info("on-chain: " + ((onChain.length - 2) / 2) + " bytes");

    info("Checking proxy signals...");
    var blockscoutProxy = await lookupBlockscoutProxy({
      chainId: net.chainId,
      address: address,
      apiKey: blockscoutKey,
      instanceBase: BLOCKSCOUT[net.chainId],
    });
    var proxy = await detectProxy({
      bytecode: onChain,
      contractName: src.contractName,
      blockscout: blockscoutProxy,
      readStorage: function(slot) {
        return rpc("eth_getStorageAt", [address, slot, "latest"]);
      },
    });
    if (proxy.isProxy) {
      console.log("\n" + sep);
      console.log("  SKIP: proxy contract detected");
      console.log("  contract=" + src.contractName);
      console.log("  proxy_signals=" + proxy.signals.join(","));
      console.log("  proxy_bytecode_len=" + proxy.byteLength);
      if (proxy.proxyType) console.log("  proxy_type=" + proxy.proxyType);
      if (proxy.implementation) {
        console.log("  implementation=" + proxy.implementation);
        if (proxy.implementationName) console.log("  implementation_name=" + proxy.implementationName);
        console.log("  next=node index.mjs " + proxy.implementation + " " + network);
        setOutput("implementation-address", proxy.implementation);
      } else {
        console.log("  implementation=unknown");
        console.log("  next=resolve the implementation address, then verify it directly");
      }
      setOutput("proxy", "true");
      setOutput("status", "SKIP");
      console.log(sep + "\n");
      process.exit(0);
    }
    setOutput("proxy", "false");

    // Gate compilation only after proxy detection. Legacy proxy bytecode can
    // still be resolved without loading its old soljson runtime.
    var vm = String(src.compilerVersion).match(/(\d+)\.(\d+)\.(\d+)/);
    if (vm && Number(vm[1]) === 0 && Number(vm[2]) < 5) {
      console.log("\n" + sep);
      console.log("  SKIP: unsupported compiler runtime");
      console.log("  solc=" + src.compilerVersion);
      console.log("  reason=legacy soljson incompatible with current Node runtime");
      console.log(sep + "\n");
      setOutput("status", "SKIP");
      process.exit(0);
    }

    var solcPath = await downloadSolc(src.compilerVersion);
    var stdInput = buildStdInput(src);

    info("Compiling...");
    var candidates = compileSolidity(solcPath, stdInput);
    info("compiled " + candidates.length + " contract(s): " + candidates.map(function(c) { return c.name; }).join(", "));

    var result = pickBestMatch(onChain, candidates);
    var onStrip = stripMeta(onChain).toLowerCase();
    var comStrip = stripMeta(result.compiled).toLowerCase();

    console.log("\n" + sep);
    if (result.match) {
      console.log("  PASS: runtime bytecode matches compiled source");
      console.log("  provider=" + src.provider);
      console.log("  solc=" + src.compilerVersion);
      console.log("  contract=" + result.name);
      console.log("  fingerprint=" + fingerprint(onStrip));
      setOutput("status", "PASS");
    } else {
      console.log("  FAIL: bytecode mismatch");
      console.log("  provider=" + src.provider);
      console.log("  solc=" + src.compilerVersion);
      console.log("  closest_contract=" + result.name);
      console.log("  onchain_len=" + (onStrip.length / 2));
      console.log("  compiled_len=" + (comStrip.length / 2));
      console.log("  onchain_fingerprint=" + fingerprint(onStrip));
      console.log("  compiled_fingerprint=" + fingerprint(comStrip));
      // Find first diff byte
      var firstDiff = -1;
      for (var d = 0; d < Math.min(onStrip.length, comStrip.length); d += 2) {
        if (onStrip[d] !== comStrip[d] || onStrip[d+1] !== comStrip[d+1]) { firstDiff = d / 2; break; }
      }
      console.log("  first_diff_at=byte " + firstDiff + " (of " + (onStrip.length/2) + ")");
      setOutput("status", "FAIL");
    }
    setOutput("on-chain-hash", fingerprint(onStrip));
    setOutput("compiled-hash", fingerprint(comStrip));
    console.log(sep + "\n");
    if (!result.match) process.exit(1);
  } catch (err) {
    die(err.message);
  }
}

function samePath(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function isDirectRun() {
  var entry = process.argv[1];
  if (!entry) return false;
  try {
    var modulePath = fileURLToPath(import.meta.url);
    var invokedPath = resolve(entry);
    if (samePath(modulePath, invokedPath)) return true;
    return samePath(realpathSync(modulePath), realpathSync(invokedPath));
  } catch (e) {
    return false;
  }
}

if (isDirectRun()) main();
