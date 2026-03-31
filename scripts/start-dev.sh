#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Polkadot Stack Template - Local Development ==="
echo ""

# Build the runtime
echo "[1/3] Building runtime..."
cargo build -p stack-template-runtime --release

# Create the chain spec using the newly built WASM
echo "[2/3] Generating chain spec..."
chain-spec-builder \
    -c "$ROOT_DIR/blockchain/chain_spec.json" \
    create -t development \
    --relay-chain paseo \
    --para-id 1000 \
    --runtime "$ROOT_DIR/target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm" \
    named-preset development

echo "  Chain spec written to blockchain/chain_spec.json"

# Start the node
echo "[3/3] Starting omni-node in dev mode..."
echo "  RPC endpoint: ws://127.0.0.1:9944"
echo ""
polkadot-omni-node --chain "$ROOT_DIR/blockchain/chain_spec.json" --dev
