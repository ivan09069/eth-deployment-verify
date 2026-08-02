#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { detectProxy, lookupBlockscoutProxy } from "./proxy-detection.mjs";
var __dirname = dirname(fileURLToPath(import.meta.url));

const isAction = !!process.env.GITHUB_ACTIONS;
function getInput(n) { return process.env["INPUT_" + n.toUpperCase().replace(/-/g, "_")] || ""; }
function setOutput(n, v) { if (isAction && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, n + "=" + v + "\n"); }
function die(m) { console.error(isAction ? "::error::" + m : "FAIL: " + m); process.exit(1); }
function info(m) { console.log("  " + m); }
function warn(m) { console.log("  ! " + m); }

const NETWORKS = {
  mainnet: { chainId: 1, rpc: "https://ethereum-rpc.publicnode.com" },
  sepolia: { chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  polygon: { chainId: 137, rpc: "https://polygon-bor-rpc.publicnode.com" },
  arbitrum: { chainId: 42161, rpc: "https://arbitrum-one-rpc.publicnode.com" },
  optimism: { chainId: 10, rpc: "https://optimism-rpc.publicnode.com" },
  base: { chainId: 8453, rpc: "https://base-rpc.publicnode.com" },
};
const BLOCKSCOUT = {
  1: "https://eth.blockscout.com",
  137: "https://polygon.blockscout.com",
  42161: "https://arbitrum.blockscout.com",
  10: "https://optimism.blockscout.com",
  8453: "https://base.blockscout.com",
};

async function fetchJSON(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + ": " + url);
  return r.json();
}
async function rpcCall(rpcUrl, method, params) {
  var r = await fetch(rpcUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
  });
  var d = await r.json();
  if (d.error) throw new Error("RPC: " + d.error.message);
  return d.result;
}

async function trySourcify(chainId, address) {
  var addr = address.toLowerCase();
  var matches = ["full_match", "partial_match"];
  for (var i = 0; i < matches.length; i++) {
    try {
      var url = "https://repo.sourcify.dev/contracts/" + matches[i] + "/" + chainId + "/" + addr + "/metadata.json";
      var r = await fetch(url);
      if (!r.ok) continue;
      var meta = await r.json();
      var settings = meta.settings || {};
      var target = Object.entries(settings.compilationTarget || {});
      var cName = target.length ? target[0][1] : "";
      var sources = {};
      var entries = Object.entries(meta.sources || {});
      for (var j = 0; j < entries.length; j++) {
        var p = entries[j][0], s = entries[j][1];
        if (s.content) { sources[p] = { content: s.content }; continue; }
        var srcR = await fetch("https://repo.sourcify.dev/contracts/" + matches[i] + "/" + chainId + "/" + addr + "/sources/" + p);
        if (srcR.ok) sources[p] = { content: await srcR.text() };
      }
      var opt = settings.optimizer || {};
      return {
        provider: "sourcify", contractName: cName,
        compilerVersion: (meta.compiler && meta.compiler.version || "").replace(/^v/, ""),
        optimizationUsed: !!opt.enabled, runs: opt.runs || 200,
        evmVersion: settings.evmVersion || "default", sources: sources, settings: settings,
      };
    } catch (e) { continue; }
  }
  return null;
}

async function tryBlockscout(chainId, address) {
  var base = BLOCKSCOUT[chainId];
  if (!base) return null;
  try {
    var url = base + "/api/v2/smart-contracts/" + address;
    var r = await fetch(url);
    if (!r.ok) return null;
    var d = await r.json();
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
  } catch (e) { return null; }
}

async function tryEtherscan(chainId, address, apiKey) {
  if (!apiKey) return null;
  try {
    var url = "https://api.etherscan.io/v2/api?chainid=" + chainId + "&module=contract&action=getsourcecode&address=" + address + "&apikey=" + apiKey;
    var d = await fetchJSON(url);
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

async function downloadSolc(version) {
  var ver = version.split("+")[0];
  var dir = join(tmpdir(), "eth-deploy-verify");
  mkdirSync(dir, { recursive: true });
  var solcPath = join(dir, "soljson-" + ver + ".js");
  if (existsSync(solcPath)) { info("solc " + ver + " cached"); return solcPath; }
  info("Downloading solc-js " + ver + "...");
  var list = await fetchJSON("https://binaries.soliditylang.org/bin/list.json");
  var file = list.releases && list.releases[ver];
  if (!file) throw new Error("solc " + ver + " not in releases");
  var resp = await fetch("https://binaries.soliditylang.org/bin/" + file);
  if (!resp.ok) throw new Error("solc download failed: " + resp.status);
  writeFileSync(solcPath, Buffer.from(await resp.arrayBuffer()));
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

function keccak(hex) {
  return createHash("sha256").update(hex).digest("hex").slice(0, 16);
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
  if (!rpcUrl) rpcUrl = net.rpc;

  var sep = "========================================================";
  console.log("\n" + sep);
  console.log("  eth-deployment-verify");
  console.log(sep);
  info("Address: " + address);
  info("Network: " + network + " (chain " + net.chainId + ")");
  console.log(sep + "\n");

  try {
    info("Fetching verified source...");
    var src = await trySourcify(net.chainId, address);
    if (!src) { info("Not on Sourcify, trying Blockscout..."); src = await tryBlockscout(net.chainId, address); }
    if (!src && etherscanKey) { info("Not on Blockscout, trying Etherscan..."); src = await tryEtherscan(net.chainId, address, etherscanKey); }
    if (!src) die("Source not found on any provider. Is contract verified?");
    info("provider=" + src.provider + " contract=" + src.contractName + " solc=" + src.compilerVersion);
    var optStr = src.optimizationUsed ? "on(" + src.runs + ")" : "off";
    info("optimizer=" + optStr + " evm=" + src.evmVersion);

    info("Fetching on-chain bytecode...");
    var onChain = await rpcCall(rpcUrl, "eth_getCode", [address, "latest"]);
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
        return rpcCall(rpcUrl, "eth_getStorageAt", [address, slot, "latest"]);
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
      console.log("  keccak=" + keccak(onStrip));
      setOutput("status", "PASS");
    } else {
      console.log("  FAIL: bytecode mismatch");
      console.log("  provider=" + src.provider);
      console.log("  solc=" + src.compilerVersion);
      console.log("  closest_contract=" + result.name);
      console.log("  onchain_len=" + (onStrip.length / 2));
      console.log("  compiled_len=" + (comStrip.length / 2));
      console.log("  onchain_keccak=" + keccak(onStrip));
      console.log("  compiled_keccak=" + keccak(comStrip));
      // Find first diff byte
      var firstDiff = -1;
      for (var d = 0; d < Math.min(onStrip.length, comStrip.length); d += 2) {
        if (onStrip[d] !== comStrip[d] || onStrip[d+1] !== comStrip[d+1]) { firstDiff = d / 2; break; }
      }
      console.log("  first_diff_at=byte " + firstDiff + " (of " + (onStrip.length/2) + ")");
      setOutput("status", "FAIL");
    }
    setOutput("on-chain-hash", keccak(onStrip));
    setOutput("compiled-hash", keccak(comStrip));
    console.log(sep + "\n");
    if (!result.match) process.exit(1);
  } catch (err) {
    die(err.message);
  }
}

main();
