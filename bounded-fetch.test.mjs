import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fetchBounded, withTimeout } from "./bounded-fetch.mjs";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function runFetchChild(url) {
  const href = new URL("./bounded-fetch.mjs", import.meta.url).href;
  const code = [
    "import { fetchBounded } from " + JSON.stringify(href) + ";",
    "const started = Date.now();",
    "try {",
    "  await fetchBounded(" + JSON.stringify(url) + ", 300);",
    "  console.log('NO');",
    "} catch (error) {",
    "  console.log('ERR ' + error.name + ' ' + (Date.now() - started));",
    "}",
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 5000,
  });
}

test("withTimeout returns a completed request", async () => {
  const value = await withTimeout(1000, async () => "ok");
  assert.equal(value, "ok");
});

test("fetchBounded reads json from a local server", async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  try {
    const port = server.address().port;
    const opened = await fetchBounded("http://127.0.0.1:" + port + "/", 2000);
    assert.equal(opened.ok, true);
    assert.equal(opened.data.ok, true);
  } finally {
    await closeServer(server);
  }
});

test("a silent local server cannot keep the process alive", () => {
  return listen(() => {}).then(async (server) => {
    try {
      const port = server.address().port;
      const result = runFetchChild("http://127.0.0.1:" + port + "/stall");
      assert.equal(result.status, 0, (result.stderr || "") + (result.stdout || ""));
      assert.match(result.stdout, /ERR TimeoutError (\d+)/);
      const elapsed = Number(result.stdout.match(/ERR TimeoutError (\d+)/)[1]);
      assert.ok(elapsed < 4000);
    } finally {
      await closeServer(server);
    }
  });
});

test("a stalled response body cannot keep the process alive", () => {
  return listen((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":');
  }).then(async (server) => {
    try {
      const port = server.address().port;
      const result = runFetchChild("http://127.0.0.1:" + port + "/body");
      assert.equal(result.status, 0, (result.stderr || "") + (result.stdout || ""));
      assert.match(result.stdout, /ERR TimeoutError/);
    } finally {
      await closeServer(server);
    }
  });
});
