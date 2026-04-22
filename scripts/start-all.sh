#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/common.sh"

ETH_RPC_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    if [ -n "$FRONTEND_PID" ]; then
        kill "$FRONTEND_PID" 2>/dev/null || true
        wait "$FRONTEND_PID" 2>/dev/null || true
    fi
    if [ -n "$ETH_RPC_PID" ]; then
        kill "$ETH_RPC_PID" 2>/dev/null || true
        wait "$ETH_RPC_PID" 2>/dev/null || true
    fi
    cleanup_zombienet
}
trap cleanup EXIT INT TERM

echo "=== Polkadot Stack Template - Full Local Stack ==="
echo ""
log_info "This is the recommended one-command path."
log_info "It uses Zombienet (relay chain + parachain) so all examples work,"
log_info "including Statement Store."
log_info "Override ports with STACK_PORT_OFFSET or STACK_*_PORT environment variables."
log_info "First run can take 5-10 minutes because it installs npm dependencies,"
log_info "compiles contracts, and waits for the relay-backed network to come up."
echo ""

validate_full_external_toolchain
validate_full_stack_ports

echo "[1/8] Building runtime..."
build_runtime

echo "[2/8] Generating chain spec..."
generate_chain_spec

echo "[3/8] Compiling contracts..."
cd "$ROOT_DIR/contracts/evm" && npm install --silent && npx hardhat compile
cd "$ROOT_DIR/contracts/pvm" && npm install --silent && npx hardhat compile
cd "$ROOT_DIR"

echo "[4/8] Starting Zombienet (relay chain + parachain)..."
log_info "This takes longer than dev mode because the relay chain must finalize"
log_info "and the parachain must register before the collator starts authoring."
start_zombienet_background
wait_for_substrate_rpc

echo "[5/8] Starting eth-rpc adapter..."
start_eth_rpc_background
wait_for_eth_rpc

echo "[6/8] Deploying contracts..."
echo "  Deploying ProofOfExistence via EVM (solc)..."
cd "$ROOT_DIR/contracts/evm"
npm run deploy:local

echo "  Deploying ProofOfExistence via PVM (resolc)..."
cd "$ROOT_DIR/contracts/pvm"
npm run deploy:local

echo "  Deploying CoveredCall via PVM (Rust)..."
cd "$ROOT_DIR/contracts/pvm-rust/e2e"
npm run deploy:covered-call

cd "$ROOT_DIR"

echo "[7/8] Building CLI..."
cargo build -p stack-cli --release

echo "[8/8] Starting frontend..."
cd "$ROOT_DIR/web"
npm install

if curl -s -o /dev/null "$SUBSTRATE_RPC_HTTP" 2>/dev/null; then
    log_info "Updating PAPI descriptors..."
    update_papi_descriptors
fi

export_frontend_runtime_env
npm run dev -- --host 127.0.0.1 --port "$STACK_FRONTEND_PORT" &
FRONTEND_PID=$!
log_info "Frontend starting at $FRONTEND_URL"

cd "$ROOT_DIR"

echo ""
echo "=== Full local stack running ==="
log_info "Substrate RPC: $SUBSTRATE_RPC_WS"
log_info "Ethereum RPC:  $ETH_RPC_HTTP"
log_info "Frontend:      $FRONTEND_URL"
log_info "Zombienet dir: $ZOMBIE_DIR"
echo ""
log_info "Included examples: PoE pallet, EVM contract, PVM contract, Statement Store, Bulletin upload"
echo ""
log_info "Press Ctrl+C to stop all."
wait "$ZOMBIE_PID"
