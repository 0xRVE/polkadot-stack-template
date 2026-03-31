#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Polkadot Stack Template - Local Dev with Contracts ==="
echo ""

# Build the runtime
echo "[1/5] Building runtime..."
cargo build -p stack-template-runtime --release

# Create the chain spec
echo "[2/5] Generating chain spec..."
chain-spec-builder \
    -c "$ROOT_DIR/blockchain/chain_spec.json" \
    create -t development \
    --relay-chain paseo \
    --para-id 1000 \
    --runtime "$ROOT_DIR/target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm" \
    named-preset development

# Install and compile contracts
echo "[3/5] Compiling contracts..."
cd "$ROOT_DIR/contracts/evm" && npm install --silent && npx hardhat compile
cd "$ROOT_DIR/contracts/pvm" && npm install --silent && npx hardhat compile
cd "$ROOT_DIR"

# Start the node in background
echo "[4/5] Starting omni-node in dev mode..."
polkadot-omni-node --chain "$ROOT_DIR/blockchain/chain_spec.json" --dev &
NODE_PID=$!

# Wait for node to be ready
echo "  Waiting for node..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://127.0.0.1:9944 2>/dev/null; then
        echo "  Node ready (ws://127.0.0.1:9944)"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "  ERROR: Node did not start in time."
        kill $NODE_PID 2>/dev/null
        exit 1
    fi
    sleep 1
done

# Deploy contracts
echo "[5/5] Deploying contracts..."
echo "  Deploying Counter via EVM (solc)..."
cd "$ROOT_DIR/contracts/evm"
npx hardhat ignition deploy ./ignition/modules/Counter.js --network local 2>&1 || echo "  (EVM deploy skipped - eth-rpc adapter may not be running)"

echo "  Deploying Counter via PVM (resolc)..."
cd "$ROOT_DIR/contracts/pvm"
npx hardhat ignition deploy ./ignition/modules/Counter.js --network localNode 2>&1 || echo "  (PVM deploy skipped - eth-rpc adapter may not be running)"

cd "$ROOT_DIR"
echo ""
echo "=== Dev environment running ==="
echo "  Node RPC: ws://127.0.0.1:9944"
echo "  Node PID: $NODE_PID"
echo ""
echo "  Frontend: cd web && npm install && npm run dev"
echo "  Stop:     kill $NODE_PID"
echo ""
echo "Press Ctrl+C to stop."
wait $NODE_PID
