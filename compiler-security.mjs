import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const origin = 'https://binaries.soliditylang.org/bin/';

export function bytecodeSha256(hex) {
  const normalized = hex.replace(/^0x/, '');
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(normalized)) throw new Error('Invalid bytecode hex');
  return createHash('sha256').update(Buffer.from(normalized, 'hex')).digest('hex');
}

export function getActionInput(name, env = process.env) {
  // GitHub preserves hyphens in INPUT_ names; keep underscore compatibility.
  return env['INPUT_' + name.toUpperCase()] || env['INPUT_' + name.toUpperCase().replace(/-/g, '_')] || '';
}

export async function downloadSolc(version, fetcher = fetch) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\+commit\.[a-fA-F0-9]+)?$/.test(version))
    throw new Error('Invalid Solidity compiler version');
  const release = version.split('+')[0];
  const listResponse = await fetcher(origin + 'list.json', { signal: AbortSignal.timeout(30000) });
  if (!listResponse.ok) throw new Error('Compiler manifest download failed');
  const list = await listResponse.json();
  const filename = list.releases?.[release];
  if (typeof filename !== 'string' || !/^soljson-v\d+\.\d+\.\d+\+commit\.[a-fA-F0-9]+\.js$/.test(filename))
    throw new Error('Compiler release not found or invalid');
  const build = list.builds?.find(item => item.path === filename);
  if (!build || !/^0x[a-fA-F0-9]{64}$/.test(build.sha256 || ''))
    throw new Error('Compiler checksum missing');
  if (version.includes('+') && filename !== `soljson-v${version}.js`)
    throw new Error('Compiler build does not match requested version');
  const response = await fetcher(origin + filename, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Compiler download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== build.sha256.slice(2).toLowerCase()) throw new Error('Compiler checksum mismatch');
  const dir = mkdtempSync(join(tmpdir(), 'eth-deploy-verify-'));
  try {
    const path = join(dir, 'soljson.cjs');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    return path;
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}

export function compileSolidity(solcPath, stdInput, solcModule = require.resolve('solc')) {
  const dir = mkdtempSync(join(tmpdir(), 'eth-deploy-compile-'));
  try {
    const wrapper = join(dir, 'compile.cjs');
    writeFileSync(wrapper, [
      "const solc = require(process.argv[2]);",
      "const soljson = require(process.argv[3]);",
      "const compiler = solc.setupMethods(soljson);",
      "const input = require('node:fs').readFileSync(0, 'utf8');",
      "process.stdout.write(compiler.compile(input));",
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    // Compiler filenames and versions are data arguments, never generated code or shell text.
    const output = execFileSync(process.execPath, [wrapper, solcModule, solcPath], {
      input: JSON.stringify(stdInput), encoding: 'utf8', timeout: 120000,
      maxBuffer: 50 * 1024 * 1024, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'],
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    });
    const result = JSON.parse(output);
    if (result.errors?.some(error => error.severity === 'error')) throw new Error('Solidity compilation failed');
    const all = [];
    for (const [file, contracts] of Object.entries(result.contracts || {})) {
      for (const [name, contract] of Object.entries(contracts)) {
        const bytecode = contract.evm?.deployedBytecode?.object;
        if (bytecode && bytecode.length > 2) all.push({ file, name, bytecode: '0x' + bytecode });
      }
    }
    if (!all.length) throw new Error('No bytecode in compilation output');
    return all;
  } catch (error) {
    // Compiler stdout/stderr can contain source text; keep failures out of logs.
    throw new Error('Compiler execution failed; review source and compiler configuration locally');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function removeDownloadedCompiler(path) {
  rmSync(dirname(path), { recursive: true, force: true });
}
