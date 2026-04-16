#!/usr/bin/env bash
set -euo pipefail

# Shared helpers for the repo's two supported local topologies:
# - Solo dev mode (`start-dev.sh`) for the fastest runtime/pallet loop
# - Relay-backed Zombienet mode (`start-all.sh`, `start-local.sh`) for the full feature set

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$COMMON_DIR/.." && pwd)"
CHAIN_SPEC="$ROOT_DIR/blockchain/chain_spec.json"
RUNTIME_WASM="$ROOT_DIR/target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm"
STACK_PORT_OFFSET="${STACK_PORT_OFFSET:-0}"
STACK_SUBSTRATE_RPC_PORT="${STACK_SUBSTRATE_RPC_PORT:-$((9944 + STACK_PORT_OFFSET))}"
STACK_ETH_RPC_PORT="${STACK_ETH_RPC_PORT:-$((8545 + STACK_PORT_OFFSET))}"
STACK_FRONTEND_PORT="${STACK_FRONTEND_PORT:-$((5173 + STACK_PORT_OFFSET))}"
STACK_COLLATOR_P2P_PORT="$((30333 + STACK_PORT_OFFSET))"
STACK_COLLATOR_PROMETHEUS_PORT="$((9615 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_RPC_PORT="$((9949 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_P2P_PORT="$((30335 + STACK_PORT_OFFSET))"
STACK_RELAY_ALICE_PROMETHEUS_PORT="$((9617 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_RPC_PORT="$((9951 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_P2P_PORT="$((30336 + STACK_PORT_OFFSET))"
STACK_RELAY_BOB_PROMETHEUS_PORT="$((9618 + STACK_PORT_OFFSET))"
SUBSTRATE_RPC_HTTP="${SUBSTRATE_RPC_HTTP:-http://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT}}"
SUBSTRATE_RPC_WS="${SUBSTRATE_RPC_WS:-ws://127.0.0.1:${STACK_SUBSTRATE_RPC_PORT}}"
ETH_RPC_HTTP="${ETH_RPC_HTTP:-http://127.0.0.1:${STACK_ETH_RPC_PORT}}"
FRONTEND_URL="${FRONTEND_URL:-http://127.0.0.1:${STACK_FRONTEND_PORT}}"

ZOMBIE_DIR="${ZOMBIE_DIR:-}"
ZOMBIE_LOG="${ZOMBIE_LOG:-}"
ZOMBIE_PID="${ZOMBIE_PID:-}"
ZOMBIE_CONFIG="${ZOMBIE_CONFIG:-}"
NODE_DIR="${NODE_DIR:-}"
NODE_LOG="${NODE_LOG:-}"
NODE_PID="${NODE_PID:-}"
ETH_RPC_PID="${ETH_RPC_PID:-}"

export STACK_PORT_OFFSET
export STACK_SUBSTRATE_RPC_PORT
export STACK_ETH_RPC_PORT
export STACK_FRONTEND_PORT
export SUBSTRATE_RPC_HTTP
export SUBSTRATE_RPC_WS
export ETH_RPC_HTTP
export FRONTEND_URL

# Expected versions for polkadot-sdk stable2603 (see README "Key Versions").
STACK_EXPECTED_POLKADOT_SEMVER="${STACK_EXPECTED_POLKADOT_SEMVER:-1.21.3}"
STACK_EXPECTED_OMNI_NODE_SEMVER="${STACK_EXPECTED_OMNI_NODE_SEMVER:-1.21.3}"
STACK_EXPECTED_ETH_RPC_SEMVER="${STACK_EXPECTED_ETH_RPC_SEMVER:-0.14.0}"
STACK_EXPECTED_CHAIN_SPEC_BUILDER_SEMVER="${STACK_EXPECTED_CHAIN_SPEC_BUILDER_SEMVER:-17.0.0}"
# zombienet prints bare semver (e.g. 1.3.138); allow any 1.3.x patch.
STACK_EXPECTED_ZOMBIE_MAJOR_MINOR="${STACK_EXPECTED_ZOMBIE_MAJOR_MINOR:-1.3}"
# Set to 1 to only check that commands exist (not recommended).
STACK_SKIP_BINARY_VERSION_CHECK="${STACK_SKIP_BINARY_VERSION_CHECK:-1}"

# Download polkadot / polkadot-omni-node / eth-rpc into a gitignored folder and prepend it on PATH
# so mismatched global installs (e.g. older ~/.cargo/bin) do not break Zombienet.
STACK_LOCAL_BIN_DIR="${STACK_LOCAL_BIN_DIR:-$ROOT_DIR/bin}"
STACK_SDK_RELEASE_TAG="${STACK_SDK_RELEASE_TAG:-polkadot-stable2603}"
STACK_DOWNLOAD_SDK_BINARIES="${STACK_DOWNLOAD_SDK_BINARIES:-1}"

log_info() {
    echo "INFO: $*"
}

log_warn() {
    echo "WARN: $*"
}

log_error() {
    echo "ERROR: $*" >&2
}

install_hint() {
    case "$1" in
        cargo)
            echo "Install Rust via rustup: https://rustup.rs/"
            ;;
        chain-spec-builder)
            echo "Install with: cargo install staging-chain-spec-builder"
            ;;
        zombienet)
            echo "Install with: npm install -g @zombienet/cli"
            ;;
        polkadot|polkadot-omni-node|eth-rpc)
            echo "Run ./scripts/download-sdk-binaries.sh to fetch stable2512-3 assets into ./bin/, or see docs/INSTALL.md."
            ;;
        curl)
            echo "Install curl with your system package manager."
            ;;
        *)
            echo "See docs/INSTALL.md for setup guidance."
            ;;
    esac
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log_error "Missing required command: $1"
        log_info "$(install_hint "$1")"
        exit 1
    fi
}

# First X.Y.Z in text (first line only for multi-line --version output).
first_line_semver() {
    echo "$1" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

stack_sdk_remote_filename() {
    local tool="$1"
    case "$(uname -s):$(uname -m)" in
        Darwin:arm64)
            printf '%s-aarch64-apple-darwin\n' "$tool"
            ;;
        Linux:x86_64)
            printf '%s\n' "$tool"
            ;;
        *)
            log_error "No prebuilt $tool for $(uname -s) $(uname -m) in ${STACK_SDK_RELEASE_TAG}."
            log_info "Supported: macOS Apple Silicon (arm64), Linux x86_64. Otherwise build from source (docs/INSTALL.md)."
            exit 1
            ;;
    esac
}

stack_sdk_expected_semver() {
    case "$1" in
        polkadot) printf '%s\n' "$STACK_EXPECTED_POLKADOT_SEMVER" ;;
        polkadot-prepare-worker | polkadot-execute-worker) printf '%s\n' "$STACK_EXPECTED_POLKADOT_SEMVER" ;;
        polkadot-omni-node) printf '%s\n' "$STACK_EXPECTED_OMNI_NODE_SEMVER" ;;
        eth-rpc) printf '%s\n' "$STACK_EXPECTED_ETH_RPC_SEMVER" ;;
        *)
            log_error "Internal error: unknown SDK binary: $1"
            exit 1
            ;;
    esac
}

_ensure_one_sdk_binary() {
    local name="$1"
    local dest="$STACK_LOCAL_BIN_DIR/$name"
    local expected
    expected="$(stack_sdk_expected_semver "$name")"
    local need_dl=1

    if [[ -x "$dest" ]]; then
        if [[ "$STACK_SKIP_BINARY_VERSION_CHECK" == "1" ]]; then
            need_dl=0
        else
            local out ver
            out="$("$dest" --version 2>&1)" || true
            ver="$(first_line_semver "$out")"
            if [[ "$ver" == "$expected" ]]; then
                need_dl=0
            elif [[ -z "$ver" && "$name" == polkadot-prepare-worker ]]; then
                need_dl=0
            elif [[ -z "$ver" && "$name" == polkadot-execute-worker ]]; then
                # Workers may not print a semver; keep existing file if present.
                need_dl=0
            else
                log_info "Refreshing $name in $STACK_LOCAL_BIN_DIR (found ${ver:-?}, want $expected)."
            fi
        fi
    fi

    if [[ "$need_dl" -eq 0 ]]; then
        return 0
    fi

    local url remote tmp
    remote="$(stack_sdk_remote_filename "$name")"
    url="https://github.com/paritytech/polkadot-sdk/releases/download/${STACK_SDK_RELEASE_TAG}/${remote}"
    tmp="$(mktemp "${TMPDIR:-/tmp}/stack-sdk.XXXXXX")"
    log_info "Downloading $name ($STACK_SDK_RELEASE_TAG)..."
    if ! curl -fsSL "$url" -o "$tmp"; then
        rm -f "$tmp"
        log_error "Failed to download $name from $url"
        log_info "Install manually (docs/INSTALL.md) or set STACK_DOWNLOAD_SDK_BINARIES=0 to use binaries on your PATH."
        exit 1
    fi
    chmod +x "$tmp"
    mv "$tmp" "$dest"

    if [[ "$STACK_SKIP_BINARY_VERSION_CHECK" != "1" ]]; then
        local out2 ver2
        out2="$("$dest" --version 2>&1)" || true
        ver2="$(first_line_semver "$out2")"
        if [[ -n "$ver2" && "$ver2" != "$expected" ]]; then
            log_error "Downloaded $name reports version $ver2, expected $expected."
            exit 1
        fi
    fi
}

# Ensures listed SDK binaries exist under STACK_LOCAL_BIN_DIR and prepends that directory on PATH.
# Names: polkadot | polkadot-prepare-worker | polkadot-execute-worker | polkadot-omni-node | eth-rpc
# Relay polkadot requires the two worker binaries beside it on PATH (same release).
ensure_local_sdk_binaries() {
    [[ "${STACK_DOWNLOAD_SDK_BINARIES:-1}" == "1" ]] || return 0
    if [[ "$#" -eq 0 ]]; then
        return 0
    fi
    require_command curl
    mkdir -p "$STACK_LOCAL_BIN_DIR"
    local n
    for n in "$@"; do
        _ensure_one_sdk_binary "$n"
    done
    export PATH="$STACK_LOCAL_BIN_DIR:$PATH"
}

require_cmd_semver_exact() {
    local cmd="$1"
    local expected="$2"
    local label="${3:-$1}"

    if [[ "$STACK_SKIP_BINARY_VERSION_CHECK" == "1" ]]; then
        require_command "$cmd"
        return 0
    fi

    require_command "$cmd"
    local out ver
    out="$("$cmd" --version 2>&1)" || true
    ver="$(first_line_semver "$out")"
    if [[ -z "$ver" ]]; then
        log_error "Could not parse a version from $label ($cmd --version)."
        log_info "Output was:"
        echo "$out" >&2
        exit 1
    fi
    if [[ "$ver" != "$expected" ]]; then
        log_error "$label: expected $expected (polkadot-sdk stable2512-3), found $ver."
        log_info "Output: $(echo "$out" | head -1)"
        log_info "$(install_hint "$cmd")"
        exit 1
    fi
}

require_zombienet_cli_version() {
    if [[ "$STACK_SKIP_BINARY_VERSION_CHECK" == "1" ]]; then
        require_command zombienet
        return 0
    fi

    require_command zombienet
    local ver
    ver="$(zombienet version 2>&1 | head -1 | tr -d '\r\n')"
    if [[ -z "$ver" ]] || [[ ! "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        log_error "Could not parse zombienet CLI version (expected output like 1.3.138)."
        log_info "Got: '$ver'"
        log_info "$(install_hint zombienet)"
        exit 1
    fi
    local major_minor
    major_minor="${ver%.*}"
    if [[ "$major_minor" != "$STACK_EXPECTED_ZOMBIE_MAJOR_MINOR" ]]; then
        log_error "zombienet CLI: expected ${STACK_EXPECTED_ZOMBIE_MAJOR_MINOR}.x (see README), found $ver."
        log_info "$(install_hint zombienet)"
        exit 1
    fi
}

validate_chain_spec_builder_version() {
    require_cmd_semver_exact chain-spec-builder "$STACK_EXPECTED_CHAIN_SPEC_BUILDER_SEMVER" "chain-spec-builder"
}

validate_zombienet_node_binaries() {
    require_cmd_semver_exact polkadot "$STACK_EXPECTED_POLKADOT_SEMVER" "polkadot (relay chain)"
    require_cmd_semver_exact polkadot-omni-node "$STACK_EXPECTED_OMNI_NODE_SEMVER" "polkadot-omni-node"
    require_zombienet_cli_version
}

validate_zombienet_toolchain() {
    ensure_local_sdk_binaries polkadot polkadot-prepare-worker polkadot-execute-worker polkadot-omni-node
    validate_chain_spec_builder_version
    validate_zombienet_node_binaries
}

validate_full_external_toolchain() {
    ensure_local_sdk_binaries polkadot polkadot-prepare-worker polkadot-execute-worker polkadot-omni-node eth-rpc
    validate_chain_spec_builder_version
    validate_zombienet_node_binaries
    require_cmd_semver_exact eth-rpc "$STACK_EXPECTED_ETH_RPC_SEMVER" "eth-rpc (pallet-revive-eth-rpc)"
}

validate_solo_dev_toolchain() {
    ensure_local_sdk_binaries polkadot-omni-node
    validate_chain_spec_builder_version
    require_cmd_semver_exact polkadot-omni-node "$STACK_EXPECTED_OMNI_NODE_SEMVER" "polkadot-omni-node"
}

require_port_free() {
    local port="$1"
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        log_error "Port $port is already in use."
        lsof -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -5 >&2
        log_info "Stop the process above or choose a different port before retrying."
        exit 1
    fi
}

require_ports_free() {
    local port
    for port in "$@"; do
        require_port_free "$port"
    done
}

require_distinct_ports() {
    local seen="|"
    local label
    local port

    while [ "$#" -gt 1 ]; do
        label="$1"
        port="$2"
        shift 2

        if [[ "$seen" == *"|$port|"* ]]; then
            log_error "Port assignment conflict detected for $label ($port)."
            log_info "Adjust STACK_PORT_OFFSET or the explicit STACK_*_PORT overrides and retry."
            exit 1
        fi

        seen="${seen}${port}|"
    done
}

validate_zombienet_ports() {
    require_distinct_ports \
        "Substrate RPC" "$STACK_SUBSTRATE_RPC_PORT" \
        "Relay Alice RPC" "$STACK_RELAY_ALICE_RPC_PORT" \
        "Relay Alice P2P" "$STACK_RELAY_ALICE_P2P_PORT" \
        "Relay Alice Prometheus" "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "Relay Bob RPC" "$STACK_RELAY_BOB_RPC_PORT" \
        "Relay Bob P2P" "$STACK_RELAY_BOB_P2P_PORT" \
        "Relay Bob Prometheus" "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "Collator P2P" "$STACK_COLLATOR_P2P_PORT" \
        "Collator Prometheus" "$STACK_COLLATOR_PROMETHEUS_PORT"

    require_ports_free \
        "$STACK_SUBSTRATE_RPC_PORT" \
        "$STACK_RELAY_ALICE_RPC_PORT" \
        "$STACK_RELAY_ALICE_P2P_PORT" \
        "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "$STACK_RELAY_BOB_RPC_PORT" \
        "$STACK_RELAY_BOB_P2P_PORT" \
        "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "$STACK_COLLATOR_P2P_PORT" \
        "$STACK_COLLATOR_PROMETHEUS_PORT"
}

validate_full_stack_ports() {
    require_distinct_ports \
        "Substrate RPC" "$STACK_SUBSTRATE_RPC_PORT" \
        "Ethereum RPC" "$STACK_ETH_RPC_PORT" \
        "Frontend" "$STACK_FRONTEND_PORT" \
        "Relay Alice RPC" "$STACK_RELAY_ALICE_RPC_PORT" \
        "Relay Alice P2P" "$STACK_RELAY_ALICE_P2P_PORT" \
        "Relay Alice Prometheus" "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "Relay Bob RPC" "$STACK_RELAY_BOB_RPC_PORT" \
        "Relay Bob P2P" "$STACK_RELAY_BOB_P2P_PORT" \
        "Relay Bob Prometheus" "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "Collator P2P" "$STACK_COLLATOR_P2P_PORT" \
        "Collator Prometheus" "$STACK_COLLATOR_PROMETHEUS_PORT"

    require_ports_free \
        "$STACK_SUBSTRATE_RPC_PORT" \
        "$STACK_ETH_RPC_PORT" \
        "$STACK_FRONTEND_PORT" \
        "$STACK_RELAY_ALICE_RPC_PORT" \
        "$STACK_RELAY_ALICE_P2P_PORT" \
        "$STACK_RELAY_ALICE_PROMETHEUS_PORT" \
        "$STACK_RELAY_BOB_RPC_PORT" \
        "$STACK_RELAY_BOB_P2P_PORT" \
        "$STACK_RELAY_BOB_PROMETHEUS_PORT" \
        "$STACK_COLLATOR_P2P_PORT" \
        "$STACK_COLLATOR_PROMETHEUS_PORT"
}

build_runtime() {
    cargo build -p stack-template-runtime --release
}

generate_chain_spec() {
    validate_chain_spec_builder_version

    chain-spec-builder \
        -c "$CHAIN_SPEC" \
        create \
        --chain-name "Polkadot Stack Template" \
        --chain-id "polkadot-stack-template" \
        -t development \
        --relay-chain rococo-local \
        --para-id 1000 \
        --runtime "$RUNTIME_WASM" \
        named-preset development
}

substrate_statement_store_ready() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"rpc_methods","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -q '"statement_submit"'
}

basic_substrate_rpc_ready() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -q '"result"'
}

substrate_block_producing() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" | grep -Eq '"number":"0x[1-9a-fA-F][0-9a-fA-F]*"'
}

startup_log_path() {
    if [ -n "$NODE_LOG" ]; then
        echo "$NODE_LOG"
    elif [ -n "$ZOMBIE_LOG" ]; then
        echo "$ZOMBIE_LOG"
    fi
}

startup_service_stopped() {
    if [ -n "$NODE_PID" ] && ! kill -0 "$NODE_PID" 2>/dev/null; then
        return 0
    fi
    if [ -n "$ZOMBIE_PID" ] && ! kill -0 "$ZOMBIE_PID" 2>/dev/null; then
        return 0
    fi
    return 1
}

# On timeout, zombienet.log is often only Prometheus polling noise; this prints RPC probes and per-node *.log tails.
dump_zombienet_startup_failure_diagnostics() {
    if [ -z "${ZOMBIE_DIR:-}" ] || [ ! -d "$ZOMBIE_DIR" ]; then
        return 0
    fi

    log_info "Collator RPC probe ($SUBSTRATE_RPC_HTTP) — shows whether the parachain answers and if statement_submit is listed:"
    local methods header
    methods="$(curl -sS --max-time 8 -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"rpc_methods","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" 2>&1)" || methods="(curl failed)"
    printf '%s\n' "$methods" | head -c 1200 | sed 's/^/  /' || true
    echo ""

    header="$(curl -sS --max-time 8 -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}' \
        "$SUBSTRATE_RPC_HTTP" 2>&1)" || header="(curl failed)"
    log_info "chain_getHeader (first ~800 chars) — need block number > 0 for scripts to proceed:"
    printf '%s\n' "$header" | head -c 800 | sed 's/^/  /' || true
    echo ""

    local found
    found="$(find "$ZOMBIE_DIR" -type f -name '*.log' 2>/dev/null | head -25)"
    if [ -z "$found" ]; then
        log_info "No *.log files found under $ZOMBIE_DIR yet."
        log_info "List temp dir before exit: ls -laR \"$ZOMBIE_DIR\""
        return 0
    fi
    log_info "Per-node log tails (most useful for relay/collator errors):"
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        log_info "--- $f ---"
        tail -n 40 "$f" 2>/dev/null || true
    done <<EOF
$found
EOF
}

wait_for_substrate_rpc() {
    local startup_log
    startup_log="$(startup_log_path)"

    log_info "Waiting for local node RPCs..."
    local max_wait
    if [ -n "${ZOMBIE_PID:-}" ]; then
        max_wait="${STACK_RPC_TIMEOUT:-600}"
    else
        max_wait="${STACK_RPC_TIMEOUT:-180}"
    fi
    for _ in $(seq 1 "$max_wait"); do
        if [ -n "$NODE_PID" ] && basic_substrate_rpc_ready && substrate_block_producing; then
            log_info "Node ready at $SUBSTRATE_RPC_WS"
            return 0
        fi
        if [ -n "$ZOMBIE_PID" ] && substrate_statement_store_ready && substrate_block_producing; then
            log_info "Node ready at $SUBSTRATE_RPC_WS (Statement Store RPCs enabled)"
            return 0
        fi
        if startup_service_stopped; then
            log_error "Local node stopped during startup."
            if [ -n "${ZOMBIE_DIR:-}" ]; then
                if [ -d "${ZOMBIE_DIR}/logs" ]; then
                    log_info "If Zombienet reported [alice]/[bob] metric timeouts, open $ZOMBIE_DIR/logs and read the relay validator logs for those nodes."
                fi
                log_info "Relay binary must be polkadot ${STACK_EXPECTED_POLKADOT_SEMVER} from stable2512-3 (./scripts/download-sdk-binaries.sh installs into ./bin/)."
            fi
            if [ -n "$startup_log" ] && [ -f "$startup_log" ]; then
                log_info "Recent log output:"
                tail -n 100 "$startup_log" || true
            fi
            return 1
        fi
        sleep 1
    done

    log_error "Local node RPCs did not become ready in time (${max_wait}s)."
    log_info "Needed: parachain RPC with Statement Store (statement_submit) and at least one block."
    if [ -n "${ZOMBIE_PID:-}" ]; then
        log_info "Zombienet default wait is 600s; increase with STACK_RPC_TIMEOUT=1200 if the relay is still registering."
    else
        log_info "Increase wait with STACK_RPC_TIMEOUT=600 if the node is slow to produce blocks."
    fi
    if [ -n "${ZOMBIE_PID:-}" ]; then
        dump_zombienet_startup_failure_diagnostics
    fi
    if [ -n "$startup_log" ] && [ -f "$startup_log" ]; then
        log_info "Zombienet orchestrator log tail (often only metrics polling; see per-node logs above):"
        tail -n 40 "$startup_log" || true
    fi
    return 1
}

eth_rpc_ready() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
        "$ETH_RPC_HTTP" >/dev/null 2>&1
}

eth_rpc_block_producing() {
    curl -s \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
        "$ETH_RPC_HTTP" | grep -Eq '"result":"0x[1-9a-fA-F][0-9a-fA-F]*"'
}

wait_for_eth_rpc() {
    local eth_rpc_log
    if [ -n "$NODE_DIR" ]; then
        eth_rpc_log="$NODE_DIR/eth-rpc.log"
    else
        eth_rpc_log="$ZOMBIE_DIR/eth-rpc.log"
    fi

    log_info "Waiting for Ethereum RPC..."
    for _ in $(seq 1 120); do
        if eth_rpc_ready && { [ -n "$NODE_PID" ] || eth_rpc_block_producing; }; then
            log_info "Ethereum RPC ready at $ETH_RPC_HTTP"
            return 0
        fi
        if [ -n "$ETH_RPC_PID" ] && ! kill -0 "$ETH_RPC_PID" 2>/dev/null; then
            log_error "eth-rpc stopped during startup."
            if [ -f "$eth_rpc_log" ]; then
                log_info "Recent log output:"
                tail -n 100 "$eth_rpc_log" || true
            fi
            return 1
        fi
        sleep 1
    done

    log_error "Ethereum RPC did not become ready in time."
    if [ -f "$eth_rpc_log" ]; then
        log_info "Recent log output:"
        tail -n 100 "$eth_rpc_log" || true
    fi
    return 1
}

write_zombienet_config() {
    local config_path="$1"

    cat >"$config_path" <<EOF
[settings]
timeout = 1000

[relaychain]
chain = "rococo-local"
default_command = "polkadot"

  [[relaychain.nodes]]
  name = "alice"
  validator = true
  rpc_port = $STACK_RELAY_ALICE_RPC_PORT
  p2p_port = $STACK_RELAY_ALICE_P2P_PORT
  prometheus_port = $STACK_RELAY_ALICE_PROMETHEUS_PORT

  [[relaychain.nodes]]
  name = "bob"
  validator = true
  rpc_port = $STACK_RELAY_BOB_RPC_PORT
  p2p_port = $STACK_RELAY_BOB_P2P_PORT
  prometheus_port = $STACK_RELAY_BOB_PROMETHEUS_PORT

[[parachains]]
id = 1000
chain = "./chain_spec.json"
cumulus_based = true

  [[parachains.collators]]
  name = "collator-01"
  validator = true
  rpc_port = $STACK_SUBSTRATE_RPC_PORT
  p2p_port = $STACK_COLLATOR_P2P_PORT
  prometheus_port = $STACK_COLLATOR_PROMETHEUS_PORT
  command = "polkadot-omni-node"
  args = ["--enable-statement-store"]
EOF
}

write_papi_config() {
    local output_path="$1"

    node -e '
const fs = require("fs");
const [inputPath, outputPath, wsUrl] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(inputPath, "utf8"));
config.entries.stack_template.wsUrl = wsUrl;
fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
' "$ROOT_DIR/web/.papi/polkadot-api.json" "$output_path" "$SUBSTRATE_RPC_WS"
}

update_papi_descriptors() {
    require_command node

    local papi_config
    papi_config="$(mktemp "$ROOT_DIR/web/papi.local.XXXXXX.json")"
    write_papi_config "$papi_config"

    npm run update-types -- --config "$papi_config"
    npm run codegen -- --config "$papi_config"

    rm -f "$papi_config"
}

export_frontend_runtime_env() {
    export VITE_LOCAL_WS_URL="$SUBSTRATE_RPC_WS"
    export VITE_LOCAL_ETH_RPC_URL="$ETH_RPC_HTTP"
}

start_zombienet_background() {
    validate_zombienet_node_binaries
    validate_zombienet_ports

    ZOMBIE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/polkadot-stack-zombienet.XXXXXX")"
    ZOMBIE_LOG="$ZOMBIE_DIR/zombienet.log"
    ZOMBIE_CONFIG="$ZOMBIE_DIR/zombienet.toml"
    cp "$CHAIN_SPEC" "$ZOMBIE_DIR/chain_spec.json"
    write_zombienet_config "$ZOMBIE_CONFIG"

    (
        cd "$ZOMBIE_DIR"
        zombienet -p native -f -l text -d "$ZOMBIE_DIR" spawn zombienet.toml >"$ZOMBIE_LOG" 2>&1
    ) &
    ZOMBIE_PID=$!

    log_info "Zombienet data dir: $ZOMBIE_DIR"
    log_info "Zombienet config: $ZOMBIE_CONFIG"
    log_info "Zombienet log: $ZOMBIE_LOG"
}

start_local_node_background() {
    require_cmd_semver_exact polkadot-omni-node "$STACK_EXPECTED_OMNI_NODE_SEMVER" "polkadot-omni-node"
    require_port_free "$STACK_SUBSTRATE_RPC_PORT"

    NODE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/polkadot-stack-node.XXXXXX")"
    NODE_LOG="$NODE_DIR/node.log"

    polkadot-omni-node \
        --chain "$CHAIN_SPEC" \
        --tmp \
        --alice \
        --force-authoring \
        --dev-block-time 3000 \
        --no-prometheus \
        --unsafe-force-node-key-generation \
        --rpc-cors all \
        --rpc-port "$STACK_SUBSTRATE_RPC_PORT" \
        -- >"$NODE_LOG" 2>&1 &
    NODE_PID=$!

    log_info "Node log: $NODE_LOG"
}

run_local_node_foreground() {
    require_cmd_semver_exact polkadot-omni-node "$STACK_EXPECTED_OMNI_NODE_SEMVER" "polkadot-omni-node"
    require_port_free "$STACK_SUBSTRATE_RPC_PORT"

    polkadot-omni-node \
        --chain "$CHAIN_SPEC" \
        --tmp \
        --alice \
        --force-authoring \
        --dev-block-time 3000 \
        --no-prometheus \
        --unsafe-force-node-key-generation \
        --rpc-cors all \
        --rpc-port "$STACK_SUBSTRATE_RPC_PORT" \
        --
}

run_zombienet_foreground() {
    validate_zombienet_node_binaries
    validate_zombienet_ports

    ZOMBIE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/polkadot-stack-zombienet.XXXXXX")"
    ZOMBIE_LOG="$ZOMBIE_DIR/zombienet.log"
    ZOMBIE_CONFIG="$ZOMBIE_DIR/zombienet.toml"
    cp "$CHAIN_SPEC" "$ZOMBIE_DIR/chain_spec.json"
    write_zombienet_config "$ZOMBIE_CONFIG"

    log_info "Zombienet data dir: $ZOMBIE_DIR"
    log_info "Zombienet config: $ZOMBIE_CONFIG"
    log_info "Zombienet log: $ZOMBIE_LOG"

    trap cleanup_zombienet EXIT INT TERM

    cd "$ZOMBIE_DIR"
    zombienet -p native -f -l text -d "$ZOMBIE_DIR" spawn zombienet.toml &
    ZOMBIE_PID=$!
    wait "$ZOMBIE_PID"
}

start_eth_rpc_background() {
    ensure_local_sdk_binaries eth-rpc
    require_cmd_semver_exact eth-rpc "$STACK_EXPECTED_ETH_RPC_SEMVER" "eth-rpc (pallet-revive-eth-rpc)"
    require_port_free "$STACK_ETH_RPC_PORT"

    local eth_rpc_log
    local eth_rpc_dir
    if [ -n "$NODE_DIR" ]; then
        eth_rpc_dir="$NODE_DIR/eth-rpc"
        eth_rpc_log="$NODE_DIR/eth-rpc.log"
    else
        eth_rpc_dir="$ZOMBIE_DIR/eth-rpc"
        eth_rpc_log="$ZOMBIE_DIR/eth-rpc.log"
    fi

    eth-rpc \
        --node-rpc-url "$SUBSTRATE_RPC_WS" \
        --rpc-port "$STACK_ETH_RPC_PORT" \
        --no-prometheus \
        --rpc-cors all \
        -d "$eth_rpc_dir" >"$eth_rpc_log" 2>&1 &
    ETH_RPC_PID=$!

    log_info "eth-rpc log: $eth_rpc_log"
}

cleanup_local_node() {
    if [ -n "$NODE_PID" ]; then
        kill "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
    fi
    if [ -n "$NODE_DIR" ]; then
        rm -rf "$NODE_DIR"
    fi
}

cleanup_zombienet() {
    if [ -n "$ZOMBIE_DIR" ]; then
        pkill -INT -f "$ZOMBIE_DIR" 2>/dev/null || true
        sleep 1
        pkill -KILL -f "$ZOMBIE_DIR" 2>/dev/null || true
    fi
    if [ -n "$ZOMBIE_PID" ]; then
        wait "$ZOMBIE_PID" 2>/dev/null || true
    fi
}
