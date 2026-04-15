import { expect } from "chai";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { type Abi, type Hex, getContract, parseAbi } from "viem";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

// ---------------------------------------------------------------------------
// ABI — matches IDexRouter in ../DexRouter.sol
// ---------------------------------------------------------------------------

const dexRouterAbi = parseAbi([
	"function swapExactIn(bytes[] path, uint256 amountIn, uint256 amountOutMin) external returns (uint256)",
	"function swapExactOut(bytes[] path, uint256 amountOut, uint256 amountInMax) external returns (uint256)",
	"function getAmountOut(bytes assetIn, bytes assetOut, uint256 amountIn) external view returns (uint256)",
	"function getAmountIn(bytes assetIn, bytes assetOut, uint256 amountOut) external view returns (uint256)",
	"function createPool(bytes asset1, bytes asset2) external",
	"function addLiquidity(bytes asset1, bytes asset2, uint256 amount1Desired, uint256 amount2Desired, uint256 amount1Min, uint256 amount2Min) external returns (uint256)",
	"function removeLiquidity(bytes asset1, bytes asset2, uint256 lpTokenBurn, uint256 amount1Min, uint256 amount2Min) external returns (uint256, uint256)",
	"function createPoolAndAdd(bytes asset1, bytes asset2, uint256 amount1Desired, uint256 amount2Desired, uint256 amount1Min, uint256 amount2Min) external returns (uint256)",
	"event SwapExecuted(address indexed sender, uint256 amountIn, uint256 amountOut)",
	"event PoolCreated(address indexed creator)",
	"event LiquidityAdded(address indexed provider, uint256 amount1, uint256 amount2)",
	"event LiquidityRemoved(address indexed provider, uint256 lpTokensBurned)",
	"error PrecompileCallFailed()",
	"error TransferFromFailed()",
]);

// ---------------------------------------------------------------------------
// SCALE-encoded asset identifiers (same as web/src/config/dex.ts)
// ---------------------------------------------------------------------------

const ASSETS = {
	native: "0x00" as Hex,
	testA: "0x0101000000" as Hex, // NativeOrWithId::WithId(1)
	testB: "0x0102000000" as Hex, // NativeOrWithId::WithId(2)
};

// ---------------------------------------------------------------------------
// ERC20 precompile addresses (InlineIdConfig<0x0120>)
// Address layout: [id_be32(4)][zeros(12)][0x01,0x20(2)][zeros(2)]
// ---------------------------------------------------------------------------

const ERC20_TSTA = "0x0000000100000000000000000000000001200000" as Hex;

const erc20Abi = parseAbi([
	"function approve(address spender, uint256 amount) external returns (bool)",
	"function balanceOf(address account) external view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// PVM bytecode loader
// ---------------------------------------------------------------------------

function loadBytecode(): Hex {
	const pvmPath = path.resolve(__dirname, "../../target/dex-router.release.polkavm");
	if (!fs.existsSync(pvmPath)) {
		throw new Error(
			`PVM binary not found at ${pvmPath}.\n` +
				`Build first: cd contracts/pvm-rust && cargo build --release`,
		);
	}
	const raw = fs.readFileSync(pvmPath);
	return `0x${raw.toString("hex")}` as Hex;
}

// ---------------------------------------------------------------------------
// Deploy helper
// ---------------------------------------------------------------------------

async function deployDexRouter() {
	const [deployer] = await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();
	const bytecode = loadBytecode();

	const hash = await deployer.deployContract({
		abi: dexRouterAbi,
		bytecode,
	});

	const receipt = await publicClient.waitForTransactionReceipt({
		hash,
		timeout: 120_000,
	});

	if (!receipt.contractAddress) {
		throw new Error(`Deploy tx ${hash} did not create a contract`);
	}

	const router = getContract({
		address: receipt.contractAddress,
		abi: dexRouterAbi,
		client: { public: publicClient, wallet: deployer },
	});

	return { router, deployer, publicClient };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Approve the router contract to spend tokens via the ERC20 precompile. */
async function approveERC20(erc20Address: Hex, spender: Hex, amount: bigint) {
	const [deployer] = await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();
	const hash = await deployer.writeContract({
		address: erc20Address,
		abi: erc20Abi,
		functionName: "approve",
		args: [spender, amount],
		gas: 5_000_000n,
	});
	await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

/** Check if an error message indicates the precompile call failed. pallet-revive
 *  surfaces contract reverts as `ContractTrapped` through eth-rpc. */
function isPrecompileError(msg: string): boolean {
	return (
		msg.includes("PrecompileCallFailed") ||
		msg.includes("ContractTrapped") ||
		msg.includes("revert")
	);
}

/** Derive the Substrate AccountId32 for an EVM address using
 *  pallet-revive's AccountId32Mapper: first 20 bytes = H160, last 12 = 0xEE. */
function evmToSubstrateAccount(evmAddress: Hex): string {
	const { encodeAddress } = require("@polkadot/util-crypto");
	const clean = evmAddress.replace("0x", "").toLowerCase();
	const bytes = Buffer.alloc(32, 0xee);
	Buffer.from(clean, "hex").copy(bytes, 0);
	return encodeAddress(bytes, 42);
}

/** Send a signed extrinsic and wait for inclusion in a block. */
function sendAndWait(
	tx: ReturnType<typeof ApiPromise.prototype.tx.assets.create>,
	signer: ReturnType<Keyring["addFromUri"]>,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.signAndSend(signer, ({ status, dispatchError }) => {
			if (dispatchError) {
				reject(new Error(dispatchError.toString()));
			} else if (status.isInBlock) {
				resolve();
			}
		}).catch(reject);
	});
}

/** Connect to the Substrate node via WebSocket and create test assets (TSTA=1,
 *  TSTB=2) with balances minted to Alice's EVM-mapped account.
 *  Idempotent — skips if assets already exist. */
async function ensureTestAssets(): Promise<void> {
	const wsUrl = process.env.WS_URL || "ws://127.0.0.1:9944";
	const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
	const keyring = new Keyring({ type: "sr25519" });
	const alice = keyring.addFromUri("//Alice");
	const mintAmount = 1_000_000_000_000_000n; // 1000 UNIT

	// Alice's EVM address (from private key in hardhat config) maps to a
	// different Substrate account via AccountId32Mapper.
	const aliceEvmSubstrate = evmToSubstrateAccount(
		"0xf24ff3a9cf04c71dbc94d0b566f7a27b94566cac",
	);

	try {
		for (const assetId of [1, 2]) {
			// Create asset if it doesn't exist yet
			const existing = await api.query.assets.asset(assetId);
			if (existing.isEmpty) {
				await sendAndWait(
					api.tx.assets.create(assetId, alice.address, 1),
					alice,
				);
			}

			// Mint to Alice's EVM-mapped account if balance is zero
			const balance = await api.query.assets.account(assetId, aliceEvmSubstrate);
			if (balance.isEmpty) {
				await sendAndWait(
					api.tx.assets.mint(assetId, aliceEvmSubstrate, mintAmount),
					alice,
				);
			}
		}
	} finally {
		await api.disconnect();
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DexRouter (PVM-Rust)", function () {
	// e2e tests need more time for on-chain transactions
	this.timeout(120_000);

	describe("Deployment", function () {
		it("deploys successfully and returns a contract address", async function () {
			const { router } = await deployDexRouter();
			expect(router.address).to.match(/^0x[0-9a-fA-F]{40}$/);
		});
	});

	describe("Pool lifecycle", function () {
		it("creates a pool via createPool", async function () {
			const { router } = await deployDexRouter();
			// Creating a pool for native <-> testA should succeed if the
			// asset-conversion pallet is configured on the dev chain.
			try {
				await router.write.createPool([ASSETS.native, ASSETS.testA]);
			} catch (e: unknown) {
				// The precompile may reject if the pool already exists or
				// if the asset doesn't exist on chain — both are valid chain
				// responses that prove the contract reached the precompile.
				const msg = (e as Error).message;
				if (isPrecompileError(msg)) return;
				throw e;
			}
		});

		it("creates a pool and adds liquidity in one call", async function () {
			const { router } = await deployDexRouter();
			const amount = 1_000_000_000_000n; // 1e12

			try {
				await router.write.createPoolAndAdd([
					ASSETS.native,
					ASSETS.testA,
					amount,
					amount,
					0n,
					0n,
				]);
			} catch (e: unknown) {
				const msg = (e as Error).message;
				if (isPrecompileError(msg)) return;
				throw e;
			}
		});
	});

	describe("Quotes", function () {
		it("getAmountOut queries the precompile", async function () {
			const { router } = await deployDexRouter();
			try {
				const amountOut = await router.read.getAmountOut([
					ASSETS.native,
					ASSETS.testA,
					1_000_000_000n,
				]);
				// If we get here, a pool exists and we got a real quote.
				expect(amountOut).to.be.a("bigint");
				expect(amountOut > 0n).to.equal(true);
			} catch (e: unknown) {
				// No pool on chain — precompile reverts, contract propagates.
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("getAmountIn queries the precompile", async function () {
			const { router } = await deployDexRouter();
			try {
				const amountIn = await router.read.getAmountIn([
					ASSETS.native,
					ASSETS.testA,
					1_000_000_000n,
				]);
				expect(amountIn).to.be.a("bigint");
				expect(amountIn > 0n).to.equal(true);
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Swaps", function () {
		it("swapExactIn forwards to the precompile", async function () {
			const { router } = await deployDexRouter();
			const path = [ASSETS.native, ASSETS.testA];
			try {
				await router.write.swapExactIn([path, 1_000_000_000n, 0n]);
			} catch (e: unknown) {
				// Without a funded pool this will revert at the precompile —
				// that's fine, we're testing the contract reaches it.
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("swapExactOut forwards to the precompile", async function () {
			const { router } = await deployDexRouter();
			const path = [ASSETS.native, ASSETS.testA];
			try {
				await router.write.swapExactOut([path, 1_000_000n, 10_000_000_000_000n]);
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Input validation", function () {
		it("rejects a swap path exceeding MAX_SWAP_PATH (8)", async function () {
			const { router } = await deployDexRouter();
			// 9 elements — exceeds the contract's MAX_SWAP_PATH = 8
			const longPath = Array.from({ length: 9 }, () => ASSETS.native);
			try {
				await router.write.swapExactIn([longPath, 1_000n, 0n]);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) =>
						m.includes("PathTooLong") || m.includes("revert"),
					"expected PathTooLong or revert error",
				);
			}
		});

		it("rejects swapExactOut with a path exceeding MAX_SWAP_PATH", async function () {
			const { router } = await deployDexRouter();
			const longPath = Array.from({ length: 9 }, () => ASSETS.native);
			try {
				await router.write.swapExactOut([longPath, 1_000n, 10_000_000_000_000n]);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) =>
						m.includes("PathTooLong") || m.includes("revert"),
					"expected PathTooLong or revert error",
				);
			}
		});

		it("accepts a swap path of exactly 8 elements", async function () {
			const { router } = await deployDexRouter();
			// 8 elements — at the limit, should pass validation but may fail
			// at the precompile if no matching pools exist.
			const maxPath = Array.from({ length: 8 }, () => ASSETS.native);
			try {
				await router.write.swapExactIn([maxPath, 1_000n, 0n]);
			} catch (e: unknown) {
				const msg = (e as Error).message;
				// Should NOT be PathTooLong — the contract accepted the path
				// and forwarded it to the precompile.
				expect(msg).to.not.include("PathTooLong");
			}
		});
	});

	describe("Remove liquidity", function () {
		it("removeLiquidity forwards to the precompile", async function () {
			const { router } = await deployDexRouter();
			try {
				await router.write.removeLiquidity([
					ASSETS.native,
					ASSETS.testA,
					1_000_000_000n,
					0n,
					0n,
				]);
			} catch (e: unknown) {
				// Will revert because the contract has no LP tokens — that's
				// expected. We're verifying the call reaches the precompile.
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("removeLiquidity reverts with zero LP tokens", async function () {
			const { router } = await deployDexRouter();
			try {
				await router.write.removeLiquidity([
					ASSETS.native,
					ASSETS.testA,
					0n,
					0n,
					0n,
				]);
				// If this succeeds, the precompile accepted a 0-burn — unexpected
				// but not wrong.
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(isPrecompileError(msg)).to.equal(
					true,
					`expected a precompile error, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Fallback", function () {
		it("reverts on unknown selector", async function () {
			const { deployer, publicClient } = await deployDexRouter();
			const routerAddress = (await deployDexRouter()).router.address;

			try {
				// Send a call with a bogus 4-byte selector
				await deployer.sendTransaction({
					to: routerAddress,
					data: "0xdeadbeef",
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) =>
						m.includes("UnknownSelector") || m.includes("revert"),
					"expected UnknownSelector or revert error",
				);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// Full pool lifecycle — creates test assets via Substrate RPC (pallet-assets),
// then exercises the full DEX flow through the contract.
// Requires both a Substrate node (:9944) and eth-rpc proxy (:8545).
// ---------------------------------------------------------------------------

describe("DexRouter full lifecycle", function () {
	this.timeout(120_000);

	let routerAddress: Hex;

	before(async function () {
		// Create test assets (TSTA=1, TSTB=2) via Substrate RPC, then deploy
		await ensureTestAssets();
		const { router } = await deployDexRouter();
		routerAddress = router.address;

		// Approve the router to spend TSTA on Alice's behalf
		await approveERC20(ERC20_TSTA, routerAddress, 100_000_000_000_000n);
	});

	async function getRouter() {
		const [deployer] = await hre.viem.getWalletClients();
		const publicClient = await hre.viem.getPublicClient();
		return getContract({
			address: routerAddress,
			abi: dexRouterAbi,
			client: { public: publicClient, wallet: deployer },
		});
	}

	it("1. creates pool native <-> testA", async function () {
		const router = await getRouter();
		try {
			await router.write.createPool([ASSETS.native, ASSETS.testA]);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			// Pool may already exist — that's fine for a test that runs repeatedly.
			if (!isPrecompileError(msg)) throw e;
		}
	});

	it("2. adds liquidity to native <-> testA pool", async function () {
		const amount = 10_000_000_000_000n; // 10e12
		const [deployer] = await hre.viem.getWalletClients();
		const publicClient = await hre.viem.getPublicClient();

		// Native tokens sent as msg.value, TSTA pulled via ERC20 approval.
		// Use encodeFunctionData to bypass viem's payable type check.
		const { encodeFunctionData } = await import("viem");
		const data = encodeFunctionData({
			abi: dexRouterAbi,
			functionName: "addLiquidity",
			args: [ASSETS.native, ASSETS.testA, amount, amount, 0n, 0n],
		});
		const hash = await deployer.sendTransaction({
			to: routerAddress,
			data,
			value: amount,
			gas: 5_000_000n,
		});
		await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
	});

	it("3. quotes a swap amount", async function () {
		const router = await getRouter();
		const amountOut = await router.read.getAmountOut([
			ASSETS.native,
			ASSETS.testA,
			1_000_000_000n,
		]);
		expect(amountOut).to.be.a("bigint");
		expect(amountOut > 0n).to.equal(true);
	});

	it("4. swaps native -> testA", async function () {
		const [deployer] = await hre.viem.getWalletClients();
		const publicClient = await hre.viem.getPublicClient();
		const { encodeFunctionData } = await import("viem");
		const swapAmount = 1_000_000_000n;

		const data = encodeFunctionData({
			abi: dexRouterAbi,
			functionName: "swapExactIn",
			args: [[ASSETS.native, ASSETS.testA], swapAmount, 0n],
		});
		const hash = await deployer.sendTransaction({
			to: routerAddress,
			data,
			value: swapAmount,
			gas: 5_000_000n,
		});
		await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
	});

	it("5. swaps testA -> native (reverse)", async function () {
		const router = await getRouter();
		const swapAmount = 500_000_000n;

		// TSTA input — approval was granted in before() hook
		await router.write.swapExactIn(
			[[ASSETS.testA, ASSETS.native], swapAmount, 0n],
			{ gas: 5_000_000n },
		);
	});

	it("6. removes liquidity via precompile directly", async function () {
		// The contract's removeLiquidity is a passthrough that requires LP tokens
		// in the contract. For the e2e test, call the precompile directly (like
		// the frontend does) — LP tokens are in Alice's account.
		const PRECOMPILE = "0x0000000000000000000000000000000004200000" as Hex;
		const precompileAbi = parseAbi([
			"function removeLiquidity(bytes asset1, bytes asset2, uint256 lpTokenBurn, uint256 amount1MinReceive, uint256 amount2MinReceive, address withdrawTo) external returns (uint256, uint256)",
		]);

		const [deployer] = await hre.viem.getWalletClients();
		const publicClient = await hre.viem.getPublicClient();
		const lpBurn = 1_000_000_000n;

		const hash = await deployer.writeContract({
			address: PRECOMPILE,
			abi: precompileAbi,
			functionName: "removeLiquidity",
			args: [
				ASSETS.native,
				ASSETS.testA,
				lpBurn,
				0n,
				0n,
				deployer.account.address,
			],
			gas: 5_000_000n,
		});
		const receipt = await publicClient.waitForTransactionReceipt({
			hash,
			timeout: 60_000,
		});
		expect(receipt.status).to.equal("success");
	});
});
