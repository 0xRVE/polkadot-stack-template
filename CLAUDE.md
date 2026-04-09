# CLAUDE.md

This file provides context for AI agents working with this repository.

## Project Purpose

A developer starter template for the **Polkadot Blockchain Academy** demonstrating the full Polkadot technology stack through a **Proof of Existence** system. The same concept — claim and revoke ownership of file hashes on-chain — is implemented as a Substrate pallet, a Solidity EVM contract, a Solidity PVM contract, a React frontend, and a Rust CLI.

Students do not need to use every part. Components are intentionally separated so teams can keep only the slices they want.

## Component Map

| Component | Path | Tech |
|---|---|---|
| FRAME Pallet | `blockchain/pallets/template/` | Rust, FRAME, polkadot-sdk |
| Parachain Runtime | `blockchain/runtime/` | Rust, Cumulus, pallet-revive |
| EVM Contract | `contracts/evm/` | Solidity 0.8.28, Hardhat, solc |
| PVM Contract | `contracts/pvm/` | Solidity 0.8.28, Hardhat, resolc (PolkaVM) |
| Frontend | `web/` | React 18, Vite, TypeScript, Tailwind, PAPI, viem |
| CLI | `cli/` | Rust, subxt, alloy, clap |
| Scripts | `scripts/` | Bash (start, deploy, test helpers) |

## How the Layers Connect

- The **pallet** is wired into the runtime at `pallet_index(50)` as `TemplatePallet`.
- **pallet-revive** (index 90) enables both EVM and PVM smart contract execution with Ethereum RPC compatibility.
- The same `ProofOfExistence.sol` is compiled via **solc** (EVM bytecode) and **resolc** (PolkaVM/RISC-V bytecode).
- The **frontend** talks to the pallet via **PAPI** over WebSocket and to contracts via **viem** through the **eth-rpc** proxy.
- The **CLI** uses **subxt** for Substrate interactions and **alloy** for Ethereum contract calls.
- Contract addresses are stored in `deployments.json` (root) and auto-synced to `web/src/config/deployments.ts` by deploy scripts.
- The local dev chain ID is `420420421`. The Polkadot Hub TestNet chain ID is `420420417`.

## Key Files

- `blockchain/pallets/template/src/lib.rs` — Pallet logic (create_claim, revoke_claim)
- `blockchain/runtime/src/lib.rs` — Runtime definition, pallet wiring, runtime APIs
- `blockchain/runtime/src/configs/mod.rs` — All pallet configuration (System, Balances, Revive, etc.)
- `blockchain/runtime/src/configs/xcm_config.rs` — XCM cross-chain messaging config
- `contracts/evm/contracts/ProofOfExistence.sol` — Solidity contract (same source for PVM)
- `web/src/pages/PalletPage.tsx` — Pallet PoE frontend page
- `web/src/components/ContractProofOfExistencePage.tsx` — Shared EVM/PVM contract page
- `web/src/config/evm.ts` — Contract ABI, dev accounts, viem client setup
- `cli/src/commands/contract.rs` — CLI contract interaction commands
- `cli/src/commands/pallet.rs` — CLI pallet interaction commands
- `cli/src/commands/prove.rs` — All-in-one prove command (hash + claim + optional upload)
- `scripts/common.sh` — Shared script utilities (port config, env setup)

## Build Commands

```bash
# Rust (runtime + pallet + CLI)
cargo build --release

# EVM contracts
cd contracts/evm && npm ci && npx hardhat compile

# PVM contracts
cd contracts/pvm && npm ci && npx hardhat compile

# Frontend
cd web && npm ci && npm run build
```

## Test Commands

```bash
# Pallet unit tests
cargo test -p pallet-template

# All Rust tests (runtime + pallet + CLI)
SKIP_PALLET_REVIVE_FIXTURES=1 cargo test --workspace --features runtime-benchmarks

# EVM contract tests
cd contracts/evm && npx hardhat test

# PVM contract tests
cd contracts/pvm && npx hardhat test
```

## Format & Lint

```bash
# Rust (requires nightly for rustfmt config options)
cargo +nightly fmt              # format
cargo +nightly fmt --check      # check only
cargo clippy --workspace        # lint

# Frontend
cd web && npm run fmt           # format
cd web && npm run fmt:check     # check only
cd web && npm run lint          # eslint

# Contracts
cd contracts/evm && npm run fmt
cd contracts/pvm && npm run fmt
```

## Docker

```bash
docker compose up -d    # builds runtime in Docker, starts node + eth-rpc
docker compose down -v  # tear down
```

- `Dockerfile.node` — multi-stage: compiles runtime WASM, generates chain spec, packages into polkadot-omni-node image
- `Dockerfile.eth-rpc` — downloads pre-built eth-rpc binary from polkadot-sdk GH release (no official Docker image exists)
- `docker-compose.yml` (root) — full stack: node (port 9944) + eth-rpc (port 8545)
- `blockchain/docker-compose.yml` — simple node-only option (requires pre-generated chain_spec.json)
- `.dockerignore` — excludes web/, contracts/, target/, node_modules/ from build context

## Running Locally

```bash
# Full stack: relay chain + collator + Statement Store + contracts + frontend
./scripts/start-all.sh

# Lightweight solo-node dev loop (no Statement Store)
./scripts/start-dev.sh

# Frontend only (for an already-running chain)
./scripts/start-frontend.sh
```

## Version Pinning

- **polkadot-sdk**: stable2512-3 (umbrella crate v2512.3.3)
- **Rust**: stable (pinned via `rust-toolchain.toml`)
- **Node.js**: 22.x LTS (pinned via `.nvmrc`)
- **Solidity**: 0.8.28
- **resolc**: 1.0.0

## Notes for AI Agents

- Dev private keys in `cli/src/commands/contract.rs` and `web/src/config/evm.ts` are **well-known Substrate dev account keys** (Alice, Bob, Charlie). They are public test keys, not secrets.
- `web/.papi/` contains checked-in PAPI descriptors so the frontend works out of the box. After modifying pallet storage or calls, regenerate with: `cd web && npx papi update && npx papi`
- `blockchain/chain_spec.json` is in `.gitignore` — it is generated at build/start time by scripts.
- The `Cargo.toml` patch for `pallet-revive-proc-macro` works around a compilation bug in stable2512-3.

## Known Gaps / Future Work

- **Runtime integration tests**: `blockchain/runtime/src/tests.rs` has only 1 compile-time API assertion test. Consider adding genesis-build smoke tests and pallet-integration tests.
- **Shell script linting**: `scripts/` has ~1180 lines of bash with no linting in CI. A workflow running `shellcheck scripts/*.sh` would catch issues.
- **deployments.json workflow**: The checked-in stub can cause merge conflicts when multiple branches deploy. Consider documenting the intended workflow or gitignoring it.
- **E2E tests in CI**: Zombienet smoke tests exist locally (`scripts/test-zombienet.sh`, `scripts/test-statement-store-smoke.sh`) but are not run in CI due to binary dependencies.
- **Docker eth-rpc image**: No official `parity/eth-rpc` Docker image exists. `Dockerfile.eth-rpc` downloads the binary from GH releases as a workaround.
- **Commit message conventions**: Consider adopting Conventional Commits for clearer changelog generation.
