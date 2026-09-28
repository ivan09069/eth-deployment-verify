import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  containsDelegatecall,
  detectProxy,
  implementationFromStorage,
  lookupBlockscoutProxy,
  minimalProxyImplementation,
} from "./proxy-detection.mjs";

const IMPLEMENTATION = "0x1111111111111111111111111111111111111111";
const MINIMAL = "0x363d3d373d3d3d363d73" + IMPLEMENTATION.slice(2) + "5af43d82803e903d91602b57fd5bf3";

test("extracts an EIP-1167 implementation", () => {
  assert.equal(minimalProxyImplementation(MINIMAL), IMPLEMENTATION);
});

test("finds executable DELEGATECALL and skips PUSH data", () => {
  assert.equal(containsDelegatecall("0x6000f4"), true);
  assert.equal(containsDelegatecall("0x60f400"), false);
  assert.equal(containsDelegatecall("0x7f" + "f4".repeat(32) + "00"), false);
});

test("does not classify a large PoolManager-like runtime from DELEGATECALL alone", async () => {
  const result = await detectProxy({
    bytecode: "0x" + "00".repeat(700) + "f4",
    contractName: "PoolManager",
  });
  assert.equal(result.isProxy, false);
  assert.deepEqual(result.signals, ["delegatecall"]);
});

test("classifies small delegatecall and known proxy names", async () => {
  assert.equal((await detectProxy({ bytecode: "0x6000f4", contractName: "Contract" })).isProxy, true);
  assert.equal((await detectProxy({
    bytecode: "0x" + "00".repeat(700) + "f4",
    contractName: "FiatTokenProxy",
  })).isProxy, true);
});

test("uses Blockscout PRO implementation as authoritative evidence", async () => {
  let requestedUrl;
  const lookup = await lookupBlockscoutProxy({
    chainId: 1,
    address: "0x2222222222222222222222222222222222222222",
    apiKey: "secret",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ implementations: [{ address_hash: IMPLEMENTATION }] }) };
    },
  });
  assert.match(requestedUrl, /^https:\/\/api\.blockscout\.com\/1\/api\/v2\//);
  assert.equal(lookup.implementation, IMPLEMENTATION);
  assert.equal(lookup.source, "blockscout-pro");
});

test("extracts the implementation from an EIP-1967 storage word", () => {
  assert.equal(
    implementationFromStorage("0x" + "00".repeat(12) + IMPLEMENTATION.slice(2)),
    IMPLEMENTATION,
  );
});

test("bounds a blockscout lookup that never responds", { timeout: 3000 }, async () => {
  const started = Date.now();
  const lookup = await lookupBlockscoutProxy({
    chainId: 1,
    address: "0x2222222222222222222222222222222222222222",
    instanceBase: "https://eth.blockscout.com",
    timeoutMs: 50,
    fetchImpl: () => new Promise(() => {}),
  });
  assert.equal(lookup, null);
  assert.ok(Date.now() - started < 2000);
});

test("bounds a blockscout body that never arrives", { timeout: 3000 }, async () => {
  const started = Date.now();
  const lookup = await lookupBlockscoutProxy({
    chainId: 1,
    address: "0x2222222222222222222222222222222222222222",
    instanceBase: "https://eth.blockscout.com",
    timeoutMs: 50,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  });
  assert.equal(lookup, null);
  assert.ok(Date.now() - started < 2000);
});

test("runs proxy detection before the legacy compiler gate", () => {
  const cli = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  assert.ok(
    cli.indexOf('info("Checking proxy signals...")') <
      cli.indexOf("// Gate compilation only after proxy detection"),
  );
});
test("passes an abort signal to Blockscout proxy lookups", async () => {
  let signal;
  await lookupBlockscoutProxy({
    chainId: 1,
    address: "0x2222222222222222222222222222222222222222",
    instanceBase: "https://eth.blockscout.com",
    fetchImpl: async (_url, options) => {
      signal = options?.signal;
      return { ok: false, status: 503, json: async () => ({}) };
    },
  });
  assert.ok(signal instanceof AbortSignal);
});
