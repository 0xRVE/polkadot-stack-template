#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Polkadot Stack Template - Local Development ==="
echo ""

# Step 1: Build the runtime
echo "[1/4] Building runtime..."
cargo build -p stack-template-runtime --release

# Step 2: Generate chain spec
echo "[2/4] Generating chain spec..."
WASM_PATH="$ROOT_DIR/target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm"

if ! command -v chain-spec-builder &> /dev/null; then
    echo "  Installing chain-spec-builder..."
    cargo install staging-chain-spec-builder
fi

chain-spec-builder \
    -c "$ROOT_DIR/blockchain/chain_spec.json" \
    create \
    -t development \
    --relay-chain paseo-local \
    --runtime "$WASM_PATH" \
    named-preset development

echo "  Chain spec written to blockchain/chain_spec.json"

# Step 3: Start the node
echo "[3/4] Starting omni-node in dev mode..."
echo "  RPC endpoint: ws://127.0.0.1:9944"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

polkadot-omni-node \
    --chain "$ROOT_DIR/blockchain/chain_spec.json" \
    --dev \
    --rpc-cors all \
    --rpc-external \
    --tmp
