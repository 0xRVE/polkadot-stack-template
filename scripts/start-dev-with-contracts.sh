#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Polkadot Stack Template - Local Dev with Contracts ==="
echo ""

# Step 1: Build the runtime
echo "[1/6] Building runtime..."
cargo build -p stack-template-runtime --release

# Step 2: Generate chain spec
echo "[2/6] Generating chain spec..."
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

# Step 3: Install contract dependencies
echo "[3/6] Installing contract dependencies..."
cd "$ROOT_DIR/contracts/evm" && npm install --silent
cd "$ROOT_DIR/contracts/pvm" && npm install --silent
cd "$ROOT_DIR"

# Step 4: Compile contracts
echo "[4/6] Compiling contracts..."
cd "$ROOT_DIR/contracts/evm" && npx hardhat compile
cd "$ROOT_DIR/contracts/pvm" && npx hardhat compile
cd "$ROOT_DIR"

# Step 5: Start the node in background
echo "[5/6] Starting omni-node in dev mode..."
echo "  RPC endpoint: ws://127.0.0.1:9944"
echo "  Ethereum RPC: http://127.0.0.1:8545 (via eth-rpc adapter)"

polkadot-omni-node \
    --chain "$ROOT_DIR/blockchain/chain_spec.json" \
    --dev \
    --rpc-cors all \
    --rpc-external \
    --tmp &

NODE_PID=$!
echo "  Node PID: $NODE_PID"

# Wait for node to start
echo "  Waiting for node to be ready..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://127.0.0.1:9944; then
        echo "  Node is ready."
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  ERROR: Node did not start in time."
        kill $NODE_PID 2>/dev/null
        exit 1
    fi
    sleep 1
done

# Step 6: Deploy contracts
echo "[6/6] Deploying contracts..."

echo "  Deploying Counter via EVM (solc)..."
cd "$ROOT_DIR/contracts/evm"
npx hardhat ignition deploy ./ignition/modules/Counter.js --network local || echo "  EVM deployment failed (eth-rpc adapter may not be running)"

echo "  Deploying Counter via PVM (resolc)..."
cd "$ROOT_DIR/contracts/pvm"
npx hardhat ignition deploy ./ignition/modules/Counter.js --network localNode || echo "  PVM deployment failed (eth-rpc adapter may not be running)"

cd "$ROOT_DIR"

echo ""
echo "=== Dev environment running ==="
echo "  Node RPC:     ws://127.0.0.1:9944"
echo "  Eth RPC:      http://127.0.0.1:8545"
echo "  Node PID:     $NODE_PID"
echo ""
echo "  To start the frontend:  cd web && npm install && npm run dev"
echo "  To stop:                kill $NODE_PID"
echo ""
echo "Press Ctrl+C to stop the node."
wait $NODE_PID
