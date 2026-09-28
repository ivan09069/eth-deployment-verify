import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprint, loadVerifiedSource } from "./index.mjs";

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
      if (String(url).includes("repo.sourcify.dev")) return new Promise(() => {});
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
  assert.equal(urls.some((url) => url.includes("repo.sourcify.dev")), true);
  assert.equal(urls.some((url) => url.includes("blockscout.com")), true);
  assert.equal(urls.some((url) => url.includes("etherscan")), false);
  assert.ok(Date.now() - started < 3000);
});

test("a sourcify body that never ends falls through to blockscout", { timeout: 3000 }, async () => {
  const started = Date.now();
  const src = await loadVerifiedSource(1, ADDRESS, "", {
    sourcifyTimeoutMs: 40,
    fetchImpl(url) {
      if (String(url).includes("repo.sourcify.dev")) {
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
