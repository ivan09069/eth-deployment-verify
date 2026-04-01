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
    etherscan-key: ${{ secrets.ETHERSCAN_API_KEY }}  # optional
```

### CLI
```bash
node index.mjs <address> <network> [etherscan-key] [rpc-url]
node index.mjs 0x6B175474E89094C44Da98b954EedeAC495271d0F mainnet
```

## Outputs

| Output | Values | Description |
|--------|--------|-------------|
| `status` | `PASS`, `FAIL`, `SKIP` | Verification result |

## Supported Networks

mainnet, sepolia, polygon, arbitrum, optimism, base

## Source Providers (tried in order)

1. **Sourcify** — free, no API key
2. **Blockscout V2** — free, no API key
3. **Etherscan V2** — requires API key (optional fallback)

## Limitations

- **Legacy solc (< 0.5.0)**: Skipped on Node 24+ due to old Emscripten binary incompatibility. Legacy support planned via pinned runtime.
- **Immutable variables**: Contracts using `immutable` (solc ≥ 0.6.5) will show FAIL because immutable values are baked into deployed bytecode at deploy time.
- **Proxy contracts**: The tool verifies the proxy bytecode, not the implementation. Proxy detection will be added in a future release.

## Example Output

```
PASS: runtime bytecode matches compiled source
provider=sourcify
solc=0.5.12+commit.7709ece9
contract=Dai
keccak=d185ab42211e2b3f
```
