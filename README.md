# @tonresistor/zkresistor-cli

Self-hosted CLI and MCP interface for ZKResistor privacy pools on TON.

Version `2.0.0` reconstructs pool state and generates Groth16 proofs locally.
Public TON infrastructure supplies chain data only. No private bridge, indexer,
or public relayer daemon is required.

## Install

Requires Node.js 22 or newer.

```bash
npm ci
npm run build
npm install -g .
```

The default mainnet Factory is:

```text
EQD3rhFaCusU0715MZonDNj8GuHeA17KygIXkBLkalpkBjle
```

## Usage

```bash
zkr wallet new --name main
zkr pools list
zkr deposit --pool EQ_pool --wallet main
zkr withdraw --note 'zkresistor:...' --to EQ_recipient --wallet main
```

| Command | Purpose |
|---|---|
| `wallet new/import/list/show/remove/export-mnemonic/sign` | Encrypted local wallets |
| `pools list` / `pools info` | Discover and inspect pools |
| `pool create` / `create-ton` / `activate` | Create and activate pools |
| `deposit` | Synchronize, prove, and deposit |
| `withdraw` | Synchronize, prove, and withdraw |
| `mcp serve` | Local stdio MCP server |

Use `--json` for structured output and `--yes` to skip write confirmations.

## Security

- A deposit note is the only way to withdraw. Store it before broadcasting.
- Notes and payloads are journaled under
  `~/.config/zkresistor/pending-deposits/` before a deposit send.
- Wallet mnemonics are encrypted locally with AES-256-GCM and scrypt.
- Verified pool state is stored under `~/.config/zkresistor/state/`.
- Withdrawals bind the complete recipient address and reject incompatible pool
  code before proving.
- Final ceremony artifacts are packaged under `artifacts/circuits/` and checked
  against pinned sizes and SHA-256 hashes before use.

The depth-20 tree has `1,048,576` slots. The bundled in-memory state provider is
a reference implementation, not a full-capacity database benchmark.

## Configuration

Common variables are `ZKR_NET`, `ZKR_FACTORY_ADDRESS`, `ZKR_RPC_ENDPOINT`,
`ZKR_RPC_API_KEY`, `ZKR_PASSPHRASE`, and `ZKR_STATE_DIR`. Non-secret defaults
may also live in `./zkresistor.config.json` or
`~/.config/zkresistor/config.json`.

## Development

```bash
npm run lint
npm test
npm run build
bash scripts/smoke.sh
```

MIT License. See [LICENSE](LICENSE).
