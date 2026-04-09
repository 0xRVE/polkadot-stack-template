# Polkadot Stack Template

A developer starter template demonstrating the full Polkadot technology stack through a **Proof of Existence** system — the same concept implemented as a Substrate pallet, a Solidity EVM contract, and a Solidity PVM contract. Drop a file, claim its hash on-chain, and optionally upload it to IPFS via the Bulletin Chain.

Students do not need to use every part of this repo. The runtime, pallet, contracts, frontend, CLI, Bulletin integration, Spektr integration, and deployment workflows are intentionally separated so teams can keep only the slices they want.

## What's Inside

### Substrate Pallet

A FRAME pallet implementing proof of existence with `create_claim` and `revoke_claim` dispatchables.

- **Source**: [`blockchain/pallets/template/`](blockchain/pallets/template/)
- **Features**: Per-hash storage, events, errors, benchmarks, weights, mock runtime, 11 unit tests
- **Interact via**: PAPI (frontend), subxt (CLI), or Polkadot.js Apps

### Parachain Runtime

A Cumulus-based parachain runtime built on **polkadot-sdk stable2512** with smart contract support.

- **Source**: [`blockchain/runtime/`](blockchain/runtime/)
- **Pallets included**: System, Balances, Aura, Session, Sudo, XCM, pallet-revive, TemplatePallet
- **pallet-revive**: Enables both EVM and PVM smart contract execution with Ethereum RPC compatibility
- **Runs locally** via the repo scripts, which start a single local omni-node for day-to-day dev and keep a separate Zombienet flow for relay-chain topology work

### Solidity Smart Contracts

The same `ProofOfExistence.sol` compiled two ways:

| | EVM (solc) | PVM (resolc) |
|---|---|---|
| **Source** | `contracts/evm/contracts/ProofOfExistence.sol` | Same file |
| **Toolchain** | [`contracts/evm/`](contracts/evm/) - Hardhat + solc + viem | [`contracts/pvm/`](contracts/pvm/) - Hardhat + @parity/resolc + viem |
| **VM Backend** | REVM (Ethereum-compatible) | PolkaVM (RISC-V) |
| **Deploy** | `npm run deploy:local` | `npm run deploy:local` |

Both target **Polkadot Hub TestNet** (Chain ID: `420420417`) or your local dev node.

### Frontend

A React + Vite + TypeScript + Tailwind CSS frontend.

- **Source**: [`web/`](web/)
- **Pallet interaction**: [Polkadot API (PAPI)](https://papi.how/) with sr25519 dev accounts (Alice, Bob, Charlie)
- **Contract interaction**: [viem](https://viem.sh/) through the eth-rpc proxy with Ethereum dev accounts
- **Endpoints**: Configurable Substrate WS and Ethereum JSON-RPC endpoints, with local-dev defaults on `localhost` and testnet defaults on hosted deployments
- **Bulletin Chain**: Optional IPFS upload via the Polkadot Bulletin Chain with clickable IPFS links
- **Pages**: Home (connection + pallet detection), Pallet PoE, EVM PoE, PVM PoE, Statements, Accounts
- **State management**: Zustand

### CLI

A Rust CLI tool using [subxt](https://github.com/parity-tech/subxt) and [alloy](https://alloy.rs) for chain interaction.

- **Source**: [`cli/`](cli/)
- **Pallet commands**: `pallet create-claim [hash | --file path] [--upload] [-s signer]`, `revoke-claim`, `get-claim`, `list-claims`
- **Contract commands**: `contract create-claim <evm|pvm> [hash | --file path] [--upload] [-s signer] [--bulletin-signer signer]`, `revoke-claim`, `get-claim`, `info`
- **Chain commands**: `chain info`, `chain blocks`, `chain statement-submit --file <path> [--signer alice] [--unsigned]`, `chain statement-dump`
- **Signers**: Pallet commands accept dev names, mnemonic phrases, or 0x secret seeds. Contract commands accept dev names or 0x Ethereum private keys.
- **Bulletin Chain**: `--upload` flag uploads files to IPFS via `TransactionStorage.store()`. When using a raw Ethereum private key for contract calls, also pass `--bulletin-signer` for the Substrate-side upload.

### Deployment

- [`scripts/start-all.sh`](scripts/start-all.sh) - Full working local stack: relay chain, collator, Statement Store, contracts, and frontend
- [`scripts/start-dev.sh`](scripts/start-dev.sh) - Lightweight solo-node runtime/pallet loop (no Statement Store on stable2512-3)
- [`scripts/start-local.sh`](scripts/start-local.sh) - Relay-backed Zombienet network only
- [`scripts/start-frontend.sh`](scripts/start-frontend.sh) - Frontend dev server for an already-running chain
- [`scripts/deploy-paseo.sh`](scripts/deploy-paseo.sh) - Deploy contracts to Polkadot TestNet
- [`scripts/deploy-frontend.sh`](scripts/deploy-frontend.sh) - Deploy frontend to IPFS
- [`.github/workflows/deploy-frontend.yml`](.github/workflows/deploy-frontend.yml) - Optional manual CI deploy to IPFS + DotNS
- [`.github/workflows/deploy-github-pages.yml`](.github/workflows/deploy-github-pages.yml) - CI deploy to GitHub Pages
- [`blockchain/Dockerfile`](blockchain/Dockerfile) - Docker image using polkadot-omni-node
- [`blockchain/zombienet.toml`](blockchain/zombienet.toml) - Example Zombienet config; local scripts generate a temp config from the active port settings

## Quick Start

### Docker (no Rust required)

```bash
# Start the parachain node + Ethereum RPC adapter (first build compiles the runtime ~10-20 min)
docker compose up -d

# Deploy contracts and start the frontend on the host
cd contracts/evm && npm install && npm run deploy:local
cd contracts/pvm && npm install && npm run deploy:local
cd web && npm install && npm run dev
# Frontend: http://127.0.0.1:5173
```

Only Node.js is needed on the host. The Docker build compiles the Rust runtime and generates the chain spec automatically.

### Prerequisites (native)

- **Rust** (stable, installed via [rustup](https://rustup.rs/))
- **Node.js** 22.x LTS (`22.5+` recommended) and npm v10.9.0+
- **polkadot** v1.21.3 ([download](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2512-3)) for the local relay chain
- **polkadot-omni-node** v1.21.3 ([download](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2512-3))
- **eth-rpc** v0.12.0 ([download](https://github.com/paritytech/polkadot-sdk/releases/tag/polkadot-stable2512-3)) - Ethereum JSON-RPC adapter
- **zombienet** for the local relay-chain + collator topology
- **chain-spec-builder** (`cargo install staging-chain-spec-builder`)

See [INSTALL.md](INSTALL.md) for detailed setup instructions.

The repo includes [`.nvmrc`](.nvmrc) and `engines` fields in the JavaScript projects to keep everyone on the same Node major version.

### Run locally

```bash
# Start everything: node, contracts, and frontend in one command
./scripts/start-all.sh
# Substrate RPC: ws://127.0.0.1:9944
# Ethereum RPC:  http://127.0.0.1:8545
# Frontend:      http://127.0.0.1:5173
```

`start-all.sh` is the recommended full-feature local path. It uses Zombienet under the hood so the Statement Store example works on `polkadot-sdk stable2512-3`.

Want a second local stack or different ports? The local scripts coordinate the chain, `eth-rpc`, CLI, contract tooling, PAPI refresh, and frontend from shared env vars:

```bash
STACK_PORT_OFFSET=100 ./scripts/start-all.sh
# Substrate RPC: ws://127.0.0.1:10044
# Ethereum RPC:  http://127.0.0.1:8645
# Frontend:      http://127.0.0.1:5273
```

Use `STACK_SUBSTRATE_RPC_PORT`, `STACK_ETH_RPC_PORT`, and `STACK_FRONTEND_PORT` if you want explicit per-service overrides instead of a shared offset.

Or run components individually:

```bash
# Start just the lightweight solo dev chain
./scripts/start-dev.sh

# Start a relay-backed local network only
./scripts/start-local.sh

# In another terminal, start the frontend
./scripts/start-frontend.sh

# Or use the CLI
cargo run -p stack-cli -- chain info
cargo run -p stack-cli -- pallet create-claim --file ./README.md
cargo run -p stack-cli -- pallet list-claims
cargo run -p stack-cli -- chain statement-submit --file ./README.md --signer alice
cargo run -p stack-cli -- chain statement-dump
```

The solo-node dev script (`start-dev.sh`) generates a local chain spec, then starts a single local omni-node on `ws://127.0.0.1:9944` by default for the fastest runtime/pallet loop. On stable2512-3 it does **not** expose Statement Store RPCs because omni-node dev mode drops the statement-store wiring. Use `./scripts/start-all.sh` when you want the full local stack, or `./scripts/start-local.sh` when you specifically need the relay-backed network.

The frontend keeps `deployments.json` and `web/src/config/deployments.ts` as checked-in stubs. Deploy scripts update both files automatically after a successful contract deployment.

If you want explicit build-time defaults for hosted frontends, copy [`web/.env.example`](web/.env.example) to `web/.env.local` and set `VITE_WS_URL` / `VITE_ETH_RPC_URL`. For local scripted development, `start-all.sh` and `start-frontend.sh` export `VITE_LOCAL_WS_URL` / `VITE_LOCAL_ETH_RPC_URL` automatically so the browser follows the active stack ports.

### Deploy contracts

```bash
# Recommended full local path
./scripts/start-all.sh

# Or, against a manually started local node:
# 1) ./scripts/start-dev.sh
# 2) eth-rpc --node-rpc-url "${SUBSTRATE_RPC_WS:-ws://127.0.0.1:9944}" --rpc-port "${STACK_ETH_RPC_PORT:-8545}" --rpc-cors all
# 3) deploy the contracts
cd contracts/evm && npm install && npm run deploy:local
cd contracts/pvm && npm install && npm run deploy:local

# Deploy to Polkadot TestNet
cd contracts/evm && npx hardhat vars set PRIVATE_KEY && npm run deploy:testnet
cd contracts/pvm && npx hardhat vars set PRIVATE_KEY && npm run deploy:testnet
```

### Lint & format

```bash
# Rust (requires nightly for rustfmt config options)
cargo +nightly fmt              # format
cargo +nightly fmt --check      # check only
cargo clippy --workspace        # lint

# Frontend (web/)
cd web && npm run fmt           # format
cd web && npm run fmt:check     # check only
cd web && npm run lint          # eslint

# Contracts (contracts/evm/ and contracts/pvm/)
cd contracts/evm && npm run fmt
cd contracts/pvm && npm run fmt
```

### Run tests

```bash
# Pallet unit tests
cargo test -p pallet-template

# All tests including benchmarks
SKIP_PALLET_REVIVE_FIXTURES=1 cargo test --workspace --features runtime-benchmarks

# Statement Store runtime + CLI coverage
cargo test -p stack-template-runtime
cargo test -p stack-cli

# Relay-backed Statement Store smoke test
./scripts/test-statement-store-smoke.sh

# Solidity tests (local Hardhat network)
cd contracts/evm && npx hardhat test
cd contracts/pvm && npx hardhat test
```

## Project Structure

```
polkadot-stack-template/
|-- blockchain/
|   |-- runtime/              Parachain runtime (polkadot-sdk stable2512)
|   |-- pallets/template/     Proof of existence pallet with tests + benchmarks
|   |-- Dockerfile            Docker image for deployment
|   |-- docker-compose.yml    Docker Compose configuration
|   `-- zombienet.toml        Multi-node test network config
|-- contracts/
|   |-- evm/                  Hardhat project (solc -> EVM) with ProofOfExistence.sol
|   `-- pvm/                  Hardhat project (resolc -> PVM) with ProofOfExistence.sol
|-- web/                      React + PAPI + viem frontend
|-- cli/                      subxt + alloy Rust CLI
|-- scripts/                  Dev and deployment scripts
|-- Cargo.toml                Rust workspace
|-- rustfmt.toml              Rust formatting (matches polkadot-sdk style)
|-- .prettierrc               Prettier config for TypeScript + Solidity
|-- .editorconfig             Editor defaults (tabs, LF, charset)
`-- rust-toolchain.toml       Pinned Rust version
```

## Documentation

- [TOOLS.md](TOOLS.md) - All Polkadot stack components used in this template
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide (GitHub Pages, DotNS, contracts, runtime)
- [INSTALL.md](INSTALL.md) - Detailed setup instructions

## Using Only What You Need

- **Pallet only**: Keep [`blockchain/pallets/template/`](blockchain/pallets/template/), [`blockchain/runtime/`](blockchain/runtime/), and optionally [`cli/`](cli/). You can ignore `contracts/`, `web/src/components/ContractProofOfExistencePage.tsx`, and `eth-rpc`.
- **Contracts only**: Keep [`contracts/`](contracts/) plus the `Revive` runtime wiring in [`blockchain/runtime/`](blockchain/runtime/). The pallet and Bulletin integration are optional.
- **Frontend only**: The core PoE UI lives in [`web/src/pages/PalletPage.tsx`](web/src/pages/PalletPage.tsx), [`web/src/pages/EvmContractPage.tsx`](web/src/pages/EvmContractPage.tsx), and [`web/src/pages/PvmContractPage.tsx`](web/src/pages/PvmContractPage.tsx). The Accounts page, Spektr support, and Bulletin upload hook can be removed without affecting the basic claim flows.
- **Optional integrations**: Bulletin Chain, Spektr, and DotNS are isolated extras. They are documented locally in [TOOLS.md](TOOLS.md) and can be skipped entirely for workshops or hackathons.

## Key Versions

| Component | Version |
|---|---|
| polkadot-sdk | stable2512-3 (umbrella crate v2512.3.3) |
| polkadot-omni-node | v1.21.3 (from stable2512-3 release) |
| eth-rpc | v0.12.0 (Ethereum JSON-RPC adapter) |
| pallet-revive | v0.12.2 (EVM + PVM smart contracts) |
| Solidity | v0.8.28 |
| resolc | v1.0.0 |
| PAPI | v1.23.3 |
| React | v18.3 |
| viem | v2.x |
| alloy | v1.8 |
| Hardhat | v2.27+ |

## Resources

- [Polkadot Smart Contract Docs](https://docs.polkadot.com/smart-contracts/overview/)
- [Polkadot SDK Documentation](https://paritytech.github.io/polkadot-sdk/master/)
- [PAPI Documentation](https://papi.how/)
- [Polkadot Faucet](https://faucet.polkadot.io/) (TestNet tokens)
- [Blockscout Explorer](https://blockscout-testnet.polkadot.io/) (Polkadot TestNet)
- [Bulletin Chain Authorization](https://paritytech.github.io/polkadot-bulletin-chain/) - On Bulletin Paseo, use `Faucet` -> `Authorize Account` to request a temporary upload allowance for the Substrate account that will sign the upload.

## License

[MIT](LICENSE)
