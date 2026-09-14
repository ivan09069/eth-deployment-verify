import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bytecodeSha256, getActionInput, downloadSolc, compileSolidity, removeDownloadedCompiler } from './compiler-security.mjs';

test('full SHA-256 hashes decoded bytes, not hex text', () => {
  assert.equal(bytecodeSha256('0x616263'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => bytecodeSha256('0xz1'));
});
test('action inputs accept GitHub hyphens and legacy underscores', () => {
  assert.equal(getActionInput('rpc-url', {'INPUT_RPC-URL':'primary','INPUT_RPC_URL':'legacy'}),'primary');
  assert.equal(getActionInput('rpc-url', {'INPUT_RPC_URL':'legacy'}),'legacy');
});
test('malicious compiler version is rejected before network access', async () => {
  let calls = 0;
  await assert.rejects(downloadSolc('../../payload', async () => {calls++;}), /Invalid/);
  assert.equal(calls,0);
});
test('checksum mismatch prevents use of downloaded JavaScript', async () => {
  const bytes = Buffer.from('untrusted fixture');
  const path = 'soljson-v0.8.30+commit.73712a01.js';
  const manifest = { releases: {'0.8.30':path}, builds:[{path,sha256:'0x'+'0'.repeat(64)}] };
  const fetcher = async url => url.endsWith('list.json') ? Response.json(manifest) : new Response(bytes);
  await assert.rejects(downloadSolc('0.8.30',fetcher),/checksum mismatch/);
});
test('verified downloads use isolated files and exact build versions', async () => {
  const bytes = Buffer.from('module.exports = {};');
  const path = 'soljson-v0.8.30+commit.73712a01.js';
  const manifest = { releases: {'0.8.30':path}, builds:[{path,sha256:'0x'+createHash('sha256').update(bytes).digest('hex')}] };
  const fetcher = async url => url.endsWith('list.json') ? Response.json(manifest) : new Response(bytes);
  const a = await downloadSolc('0.8.30',fetcher), b = await downloadSolc('0.8.30',fetcher);
  try {
    assert.notEqual(a,b); assert.deepEqual(readFileSync(a),bytes);
    await assert.rejects(downloadSolc('0.8.30+commit.12345678',fetcher),/does not match/);
  } finally { removeDownloadedCompiler(a); removeDownloadedCompiler(b); }
  assert.equal(existsSync(a),false);
});
test('compiler paths containing quotes are passed as data; parent secrets are not inherited', () => {
  const dir = mkdtempSync(join(tmpdir(),'solc-fixture-'));
  const prior = process.env.SECURITY_TEST_SECRET;
  process.env.SECURITY_TEST_SECRET = 'synthetic-fixture-only';
  try {
    const compiler = join(dir, 'compiler " quote.cjs'); writeFileSync(compiler,'module.exports = {};');
    const adapter = join(dir,'adapter.cjs');
    writeFileSync(adapter, `module.exports = {setupMethods() {return {compile() {
      if (process.env.SECURITY_TEST_SECRET) throw Error('secret inherited');
      return JSON.stringify({contracts:{'Test.sol':{Test:{evm:{deployedBytecode:{object:'6000'}}}}}});
    }}}};`);
    assert.deepEqual(compileSolidity(compiler,{},adapter),[{file:'Test.sol',name:'Test',bytecode:'0x6000'}]);
  } finally {
    if (prior === undefined) delete process.env.SECURITY_TEST_SECRET; else process.env.SECURITY_TEST_SECRET = prior;
    rmSync(dir,{recursive:true,force:true});
  }
});
