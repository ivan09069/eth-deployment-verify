const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const KNOWN_PROXY_NAME = /(?:proxy|delegator|dispatcher|beacon)/i;

function normalizeAddress(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/0x[0-9a-fA-F]{40}/);
  if (!match || /^0x0{40}$/i.test(match[0])) return null;
  return match[0];
}

function implementationFromBlockscout(data) {
  if (!data || typeof data !== "object") return null;
  const direct = normalizeAddress(data.implementation_address);
  if (direct) return direct;
  const implementations = Array.isArray(data.implementations) ? data.implementations : [];
  for (const item of implementations) {
    const address = normalizeAddress(
      typeof item === "string" ? item : item?.address_hash || item?.address || item?.hash,
    );
    if (address) return address;
  }
  return null;
}

export function containsDelegatecall(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "");
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return false;
  for (let offset = 0; offset < hex.length; offset += 2) {
    const opcode = Number.parseInt(hex.slice(offset, offset + 2), 16);
    if (opcode === 0xf4) return true;
    if (opcode >= 0x60 && opcode <= 0x7f) offset += (opcode - 0x5f) * 2;
  }
  return false;
}

export function minimalProxyImplementation(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "").toLowerCase();
  const match = hex.match(
    /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/,
  );
  return match ? "0x" + match[1] : null;
}

export function implementationFromStorage(storageWord) {
  const hex = String(storageWord || "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return normalizeAddress("0x" + hex.slice(-40));
}

export async function lookupBlockscoutProxy({ chainId, address, apiKey, instanceBase, fetchImpl = fetch }) {
  if (!ADDRESS_RE.test(address)) return null;
  const urls = [];
  if (apiKey) {
    urls.push(`https://api.blockscout.com/${chainId}/api/v2/addresses/${address}?apikey=${encodeURIComponent(apiKey)}`);
  }
  if (instanceBase) urls.push(`${instanceBase}/api/v2/addresses/${address}`);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) continue;
      const data = await response.json();
      const implementation = implementationFromBlockscout(data);
      if (implementation) {
        return {
          implementation,
          implementationName: data.implementation_name || null,
          proxyType: data.proxy_type || null,
          source: apiKey && url.includes("api.blockscout.com") ? "blockscout-pro" : "blockscout",
        };
      }
    } catch {
      // Lookup failure is non-fatal; local and storage heuristics still run.
    }
  }
  return null;
}

export async function detectProxy({ bytecode, contractName, blockscout, readStorage }) {
  const byteLength = Math.max(0, String(bytecode || "").replace(/^0x/i, "").length / 2);
  const minimalImplementation = minimalProxyImplementation(bytecode);
  const delegatecall = containsDelegatecall(bytecode);
  const smallBytecode = byteLength > 0 && byteLength < 500;
  const knownName = KNOWN_PROXY_NAME.test(String(contractName || ""));
  let storageImplementation = null;

  if (!blockscout?.implementation && typeof readStorage === "function") {
    try {
      storageImplementation = implementationFromStorage(await readStorage(EIP1967_IMPLEMENTATION_SLOT));
    } catch {
      // RPC storage lookup is best-effort.
    }
  }

  const implementation = blockscout?.implementation || minimalImplementation || storageImplementation || null;
  const signals = [];
  if (blockscout?.implementation) signals.push(blockscout.source);
  if (minimalImplementation) signals.push("eip-1167");
  if (storageImplementation) signals.push("eip-1967");
  if (smallBytecode) signals.push("small-bytecode");
  if (delegatecall) signals.push("delegatecall");
  if (knownName) signals.push("known-proxy-name");

  // Avoid PoolManager-style false positives: DELEGATECALL alone is insufficient.
  const isProxy = Boolean(implementation) || (delegatecall && (smallBytecode || knownName));
  return {
    isProxy,
    implementation,
    implementationName: blockscout?.implementationName || null,
    proxyType: blockscout?.proxyType || null,
    byteLength,
    signals,
  };
}

export { EIP1967_IMPLEMENTATION_SLOT };
