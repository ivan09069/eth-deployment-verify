# eth-deployment-verify

GitHub Action & CLI tool that verifies deployed smart contract bytecode matches compiled source.

Fetches verified source from **Sourcify** (free, no key) → **Blockscout V2** → **Etherscan V2** (fallback), recompiles with the exact solc version and settings, and compares deployed runtime bytecode.

## Usage

### GitHub Action
```yaml
- uses: ivan09069/eth-deployment-verify@v0.1.0
  with:
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F"
    network: "mainnet"
    blockscout-key: ${{ secrets.BLOCKSCOUT_API_KEY }} # optional, enables PRO lookup
    etherscan-key: ${{ secrets.ETHERSCAN_API_KEY }}     # optional fallback
```

### CLI
```bash
npm ci
node index.mjs <address> <network> [etherscan-key] [rpc-url]
node index.mjs 0x6B175474E89094C44Da98b954EedeAC495271d0F mainnet
```

`npm ci` installs the Solidity compiler wrapper. No API key is required. Each network tries its public RPCs in order; pass `rpc-url` only to force one endpoint. Sourcify is tried first, then Blockscout, then Etherscan when a key is present.

## Outputs

| Output | Values | Description |
|--------|--------|-------------|
| `status` | `PASS`, `FAIL`, `SKIP` | Verification result |
| `proxy` | `true`, `false` | Whether proxy detection triggered |
| `implementation-address` | address or empty | Resolved implementation address |
| `on-chain-hash` | 16 hex characters | Truncated SHA-256 fingerprint of the normalized on-chain bytecode hex |
| `compiled-hash` | 16 hex characters | Truncated SHA-256 fingerprint of the normalized compiled bytecode hex |

## Supported Networks

mainnet, sepolia, polygon, arbitrum, optimism, base

## Source Providers (tried in order)

1. **Sourcify** — free, no API key
2. **Blockscout V2 / PRO** — per-chain source lookup plus optional multichain PRO proxy metadata
3. **Etherscan V2** — optional API key, used only when the earlier providers do not return source

Each provider request has a deadline. A provider that does not answer is skipped, and the next provider is tried.

## Limitations

- **Legacy solc (< 0.5.0)**: Skipped on Node 24+ due to old Emscripten binary incompatibility. Legacy support planned via pinned runtime.
- **Immutable variables**: Contracts using `immutable` (solc ≥ 0.6.5) will show FAIL because immutable values are baked into deployed bytecode at deploy time.
- **Proxy contracts**: Detected before compilation using Blockscout implementation metadata, EIP-1167/EIP-1967 resolution, executable `DELEGATECALL`, bytecode size, and contract-name signals. The result is `SKIP` with the implementation address and exact next command when resolvable.

## Example Output

```
PASS: runtime bytecode matches compiled source
provider=blockscout
solc=0.5.12+commit.7709ece9
contract=Dai
fingerprint=d185ab42211e2b3f
```

`fingerprint` is the first 16 hex characters of SHA-256 over the normalized bytecode hex text. Sourcify is used when its API returns a runtime match with complete source. This sample is the Dai run with Blockscout source.

## License

Copyright (c) 2026 EchoForge Studios. All rights reserved.
No use or copy is permitted without a written license. See [LICENSE](LICENSE).
