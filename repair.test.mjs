import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, symlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { fingerprint, loadVerifiedSource, createRpc } from "./index.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const ADDRESS = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

function text(name) {
  return readFileSync(new URL("./" + name, import.meta.url), "utf8");
}

test("fingerprint is truncated SHA-256 of the bytecode hex text", () => {
  const hex = "deadbeef";
  const expected = createHash("sha256").update(hex).digest("hex").slice(0, 16);
  assert.equal(fingerprint(hex), expected);
  assert.equal(fingerprint(hex).length, 16);
});

test("cli, readme, and action describe the hash without calling it keccak", () => {
  const cli = text("index.mjs");
  const readme = text("README.md");
  const action = text("action.yml");
  for (const source of [cli, readme, action]) {
    assert.equal(/keccak/i.test(source), false);
  }
  assert.match(cli, /fingerprint=/);
  assert.match(cli, /onchain_fingerprint=/);
  assert.match(cli, /compiled_fingerprint=/);
  assert.match(cli, /createHash\("sha256"\)/);
  assert.match(readme, /fingerprint=/);
  assert.match(action, /on-chain-hash:/);
  assert.match(action, /compiled-hash:/);
  assert.match(action, /SHA-256/);
  const lines = action.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === "etherscan-key:");
  const window = lines.slice(index, index + 6).join("\n");
  assert.match(window, /required:\s*false/);
  assert.equal(/required:\s*true/.test(window), false);
});

test("direct cli execution still reports a missing address", () => {
  const result = spawnSync(process.execPath, ["index.mjs"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /Missing address/);
});

test("a hanging sourcify response falls through to blockscout", { timeout: 3000 }, async () => {
  const urls = [];
  const started = Date.now();
  const src = await loadVerifiedSource(1, ADDRESS, "", {
    sourcifyTimeoutMs: 40,
    fetchImpl(url) {
      urls.push(String(url));
      if (String(url).includes("sourcify.dev/server/v2/contract/")) return new Promise(() => {});
      return {
        ok: true,
        json: async () => ({
          source_code: "contract C {}",
          name: "C",
          compiler_version: "v0.8.20+commit.a1b79de6",
        }),
      };
    },
  });
  assert.equal(src.provider, "blockscout");
  assert.equal(src.contractName, "C");
  assert.equal(urls.some((url) => url.includes("sourcify.dev/server/v2/contract/1/")), true);
  assert.equal(urls.some((url) => url.includes("blockscout.com")), true);
  assert.equal(urls.some((url) => url.includes("etherscan")), false);
  assert.ok(Date.now() - started < 3000);
});

test("a sourcify body that never ends falls through to blockscout", { timeout: 3000 }, async () => {
  const started = Date.now();
  const src = await loadVerifiedSource(1, ADDRESS, "", {
    sourcifyTimeoutMs: 40,
    fetchImpl(url) {
      if (String(url).includes("sourcify.dev/server/v2/contract/")) {
        return { ok: true, json: () => new Promise(() => {}) };
      }
      return {
        ok: true,
        json: async () => ({ source_code: "contract C {}", name: "C", compiler_version: "0.8.20" }),
      };
    },
  });
  assert.equal(src.provider, "blockscout");
  assert.ok(Date.now() - started < 3000);
});

test("etherscan remains the last fallback when a key is present", async () => {
  const urls = [];
  const src = await loadVerifiedSource(1, ADDRESS, "test-key", {
    fetchImpl(url) {
      urls.push(String(url));
      if (!String(url).includes("etherscan")) return { ok: false, status: 404 };
      return {
        ok: true,
        json: async () => ({
          result: [{
            SourceCode: "contract C {}",
            ContractName: "C",
            CompilerVersion: "v0.8.20+commit.a1b79de6",
            OptimizationUsed: "1",
            Runs: "200",
            EVMVersion: "london",
          }],
        }),
      };
    },
  });
  assert.equal(src.provider, "etherscan");
  assert.equal(src.contractName, "C");
  assert.equal(urls.some((url) => url.includes("apikey=test-key")), true);
  const etherscanAt = urls.findIndex((url) => url.includes("etherscan"));
  const blockscoutAt = urls.findIndex((url) => url.includes("blockscout.com"));
  assert.ok(blockscoutAt >= 0 && etherscanAt > blockscoutAt);
});

function blockscoutContract() {
  return {
    ok: true,
    json: async () => ({ source_code: "contract C {}", name: "FromBlockscout", compiler_version: "0.8.20" }),
  };
}

test("sourcify runtime match keeps the compilation name and every source", async () => {
  const urls = [];
  const src = await loadVerifiedSource(1, ADDRESS, "", {
    fetchImpl(url) {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          runtimeMatch: "exact_match",
          compilation: {
            name: "Token",
            compilerVersion: "v0.8.20+commit.a1b79de6",
            compilerSettings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "london" },
          },
          sources: {
            "contracts/Token.sol": { content: "contract Token {}" },
            "contracts/Lib.sol": { content: "library Lib {}" },
          },
        }),
      };
    },
  });
  assert.equal(src.provider, "sourcify");
  assert.equal(src.contractName, "Token");
  assert.equal(src.compilerVersion, "0.8.20+commit.a1b79de6");
  assert.equal(src.optimizationUsed, true);
  assert.equal(src.runs, 200);
  assert.equal(src.evmVersion, "london");
  assert.equal(src.sources["contracts/Token.sol"].content, "contract Token {}");
  assert.equal(src.sources["contracts/Lib.sol"].content, "library Lib {}");
  assert.equal(urls.some((url) => url.includes("/server/v2/contract/1/" + ADDRESS.toLowerCase())), true);
  assert.equal(urls.some((url) => url.includes("blockscout.com")), false);
});

test("sourcify creation-only and incomplete artifacts fall through", async () => {
  const creationOnly = await loadVerifiedSource(1, ADDRESS, "", {
    fetchImpl(url) {
      if (String(url).includes("sourcify.dev")) {
        return {
          ok: true,
          json: async () => ({
            runtimeMatch: null,
            creationMatch: "exact_match",
            compilation: { name: "C", compilerVersion: "0.8.20" },
            sources: { "C.sol": { content: "contract C {}" } },
          }),
        };
      }
      return blockscoutContract();
    },
  });
  assert.equal(creationOnly.provider, "blockscout");
  assert.equal(creationOnly.contractName, "FromBlockscout");

  const incomplete = await loadVerifiedSource(1, ADDRESS, "", {
    fetchImpl(url) {
      if (String(url).includes("sourcify.dev")) {
        return {
          ok: true,
          json: async () => ({
            runtimeMatch: "match",
            compilation: { fullyQualifiedName: "contracts/C.sol:C", compilerVersion: "0.8.20" },
            sources: { "C.sol": { content: "" }, "D.sol": { content: "contract D {}" } },
          }),
        };
      }
      return blockscoutContract();
    },
  });
  assert.equal(incomplete.provider, "blockscout");
});

test("rpc skips a success body that omits result", async () => {
  const seen = [];
  const rpc = createRpc(["https://bad.example/rpc", "https://good.example/rpc"], async (url) => {
    seen.push(String(url));
    if (String(url).includes("bad")) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0xabc" }) };
  });
  assert.equal(await rpc("eth_getCode", ["0x1", "latest"]), "0xabc");
  assert.deepEqual(seen, ["https://bad.example/rpc", "https://good.example/rpc"]);
});

test("rpc accepts an explicit null result", async () => {
  const rpc = createRpc(["https://only.example/rpc"], async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
  }));
  assert.equal(await rpc("eth_getCode", []), null);
});

test("symlinked cli entry still reports a missing address", (t) => {
  const link = join(tmpdir(), "eth-deployment-verify-" + process.pid + ".mjs");
  try {
    symlinkSync(join(root, "index.mjs"), link);
  } catch (error) {
    t.skip("symlinks are not permitted here");
    return;
  }
  try {
    const result = spawnSync(process.execPath, [link], { encoding: "utf8", cwd: root });
    assert.equal(result.status, 1, (result.stderr || "") + (result.stdout || ""));
    assert.match((result.stderr || "") + (result.stdout || ""), /Missing address/);
  } finally {
    rmSync(link, { force: true });
  }
});
