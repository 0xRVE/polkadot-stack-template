import { expect } from "chai";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { type Hex, getContract, parseAbi } from "viem";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

// ---------------------------------------------------------------------------
// ABI — matches ICoveredCall in ../CoveredCall.sol
// ---------------------------------------------------------------------------

const coveredCallAbi = parseAbi([
	"function writeOption(bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 expiry) external returns (uint256)",
	"function exerciseOption(uint256 optionId) external",
	"function expireOption(uint256 optionId) external",
	"function getOption(uint256 optionId) external view returns (address seller, bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 expiry, uint256 created, uint256 status)",
	"function nextOptionId() external view returns (uint256)",
	"error PrecompileCallFailed()",
	"error TransferFromFailed()",
	"error OptionNotActive()",
	"error OptionNotExpired()",
	"error OptionAlreadyExpired()",
	"error NotInTheMoney()",
	"error InvalidAsset()",
	"error InvalidAmount()",
	"error InvalidExpiry()",
]);

// ---------------------------------------------------------------------------
// SCALE-encoded asset identifiers
// ---------------------------------------------------------------------------

const ASSETS = {
	native: "0x00" as Hex,
	testA: "0x0101000000" as Hex, // NativeOrWithId::WithId(1)
	testB: "0x0102000000" as Hex, // NativeOrWithId::WithId(2)
};

// ---------------------------------------------------------------------------
// ERC20 precompile addresses (InlineIdConfig<0x0120>)
// ---------------------------------------------------------------------------

const ERC20_TSTA = "0x0000000100000000000000000000000001200000" as Hex;
const ERC20_TSTB = "0x0000000200000000000000000000000001200000" as Hex;

const erc20Abi = parseAbi([
	"function approve(address spender, uint256 amount) external returns (bool)",
	"function balanceOf(address account) external view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// PVM bytecode loader
// ---------------------------------------------------------------------------

function loadBytecode(): Hex {
	const pvmPath = path.resolve(__dirname, "../../target/covered-call.release.polkavm");
	if (!fs.existsSync(pvmPath)) {
		throw new Error(
			`PVM binary not found at ${pvmPath}.\n` +
				`Build first: cd contracts/pvm-rust && RUSTUP_TOOLCHAIN=nightly cargo build --release`,
		);
	}
	const raw = fs.readFileSync(pvmPath);
	return `0x${raw.toString("hex")}` as Hex;
}

// ---------------------------------------------------------------------------
// Deploy helper
// ---------------------------------------------------------------------------

async function deployCoveredCall() {
	const [deployer] = await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();
	const bytecode = loadBytecode();

	const receipt = await sendWithRetry("deploy", () =>
		deployer.deployContract({ abi: coveredCallAbi, bytecode }),
	);

	if (!receipt.contractAddress) {
		throw new Error(`Deploy did not create a contract`);
	}

	const contract = getContract({
		address: receipt.contractAddress as Hex,
		abi: coveredCallAbi,
		client: { public: publicClient, wallet: deployer },
	});

	return { contract, deployer, publicClient };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendWithRetry(
	label: string,
	sendFn: () => Promise<Hex>,
	opts?: { retries?: number; receiptTimeout?: number },
): Promise<{ status: string; blockNumber: bigint; [k: string]: unknown }> {
	const publicClient = await hre.viem.getPublicClient();
	const maxAttempts = opts?.retries ?? 5;
	const timeout = opts?.receiptTimeout ?? 8_000;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			console.log(`        📝 ${label} attempt ${attempt}: sending tx...`);
			const hash = await sendFn();
			console.log(`        📝 ${label} tx hash: ${hash}`);
			const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout });
			console.log(`        ✅ ${label} confirmed in block ${receipt.blockNumber}`);
			return receipt;
		} catch (e: unknown) {
			const msg = (e as Error).message;
			if (attempt < maxAttempts && (msg.includes("Timed out") || msg.includes("Priority"))) {
				console.log(`        ⚠️  ${label} attempt ${attempt} failed: ${msg.slice(0, 100)}`);
				await waitForNextBlock();
				continue;
			}
			throw e;
		}
	}
	throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

async function approveERC20(erc20Address: Hex, spender: Hex, amount: bigint) {
	const [deployer] = await hre.viem.getWalletClients();
	await sendWithRetry("approve", () =>
		deployer.writeContract({
			address: erc20Address,
			abi: erc20Abi,
			functionName: "approve",
			args: [spender, amount],
			gas: 5_000_000n,
		}),
	);
}

async function waitForNextBlock() {
	const publicClient = await hre.viem.getPublicClient();
	const current = await publicClient.getBlockNumber();
	console.log(`        ⏳ waiting for block > ${current}...`);
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		const now = await publicClient.getBlockNumber();
		if (now > current) {
			console.log(`        ✓ block ${now} (waited ${i + 1}s)`);
			return;
		}
	}
	throw new Error(`Timed out waiting for block > ${current} after 30s`);
}

async function getChainTimestamp(): Promise<bigint> {
	const publicClient = await hre.viem.getPublicClient();
	const block = await publicClient.getBlock();
	return block.timestamp;
}

function isContractError(msg: string): boolean {
	return (
		msg.includes("ContractTrapped") ||
		msg.includes("revert") ||
		msg.includes("unknown RPC error")
	);
}

function evmToSubstrateAccount(evmAddress: Hex): string {
	const { encodeAddress } = require("@polkadot/util-crypto");
	const clean = evmAddress.replace("0x", "").toLowerCase();
	const bytes = Buffer.alloc(32, 0xee);
	Buffer.from(clean, "hex").copy(bytes, 0);
	return encodeAddress(bytes, 42);
}

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

async function ensureTestAssets(): Promise<void> {
	const wsUrl = process.env.WS_URL || "ws://127.0.0.1:9944";
	const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
	const keyring = new Keyring({ type: "sr25519" });
	const alice = keyring.addFromUri("//Alice");
	const mintAmount = 1_000_000_000_000_000n;

	const aliceEvmSubstrate = evmToSubstrateAccount("0xf24ff3a9cf04c71dbc94d0b566f7a27b94566cac");

	try {
		for (const assetId of [1, 2]) {
			const existing = await api.query.assets.asset(assetId);
			if (existing.isEmpty) {
				await sendAndWait(api.tx.assets.create(assetId, alice.address, 1), alice);
			}

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

let sharedContract: Awaited<ReturnType<typeof deployCoveredCall>>["contract"];
let sharedDeployer: Awaited<ReturnType<typeof deployCoveredCall>>["deployer"];
let sharedAddress: Hex;

before(async function () {
	this.timeout(120_000);
	await waitForNextBlock();
	await ensureTestAssets();
	await waitForNextBlock();
	const deployed = await deployCoveredCall();
	sharedContract = deployed.contract;
	sharedDeployer = deployed.deployer;
	sharedAddress = sharedContract.address;
});

describe("CoveredCall (PVM-Rust)", function () {
	this.timeout(120_000);

	let cc: typeof sharedContract;
	let deployer: typeof sharedDeployer;
	let contractAddress: Hex;

	before(async function () {
		cc = sharedContract;
		deployer = sharedDeployer;
		contractAddress = sharedAddress;

		// Approve the contract to spend both test tokens
		await approveERC20(ERC20_TSTA, contractAddress, 100_000_000_000_000n);
		await waitForNextBlock();
		await approveERC20(ERC20_TSTB, contractAddress, 100_000_000_000_000n);
	});

	describe("Deployment", function () {
		it("deploys successfully and returns a contract address", function () {
			expect(contractAddress).to.match(/^0x[0-9a-fA-F]{40}$/);
		});

		it("starts with nextOptionId = 0", async function () {
			const nextId = await cc.read.nextOptionId();
			expect(nextId).to.equal(0n);
		});
	});

	describe("Write option", function () {
		let firstOptionId: bigint;
		let firstOptionExpiry: bigint;

		it("writes an option and increments nextOptionId", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			firstOptionExpiry = chainNow + 600n; // 10 minutes from now

			firstOptionId = await cc.read.nextOptionId();

			await sendWithRetry("writeOption", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, 1_000_000_000n, 1n, firstOptionExpiry],
					{ gas: 5_000_000n },
				),
			);

			const idAfter = await cc.read.nextOptionId();
			expect(idAfter).to.equal(firstOptionId + 1n);
		});

		it("stores correct option data", async function () {
			const [seller, underlying, strikeAsset, amount, strikePrice, expiry, created, status] =
				await cc.read.getOption([firstOptionId]);

			expect(seller.toLowerCase()).to.equal(deployer.account.address.toLowerCase());
			expect(underlying.toLowerCase()).to.equal(ASSETS.testA.toLowerCase());
			expect(strikeAsset.toLowerCase()).to.equal(ASSETS.testB.toLowerCase());
			expect(amount).to.equal(1_000_000_000n);
			expect(strikePrice).to.equal(1n);
			expect(expiry).to.equal(firstOptionExpiry);
			// created is the chain timestamp at the block the tx was included —
			// it must be > 0 and ≤ the expiry we set (which is chainNow + 600)
			expect(created > 0n).to.equal(true, "created should be > 0");
			expect(created <= firstOptionExpiry).to.equal(true, "created should be <= expiry");
			expect(status).to.equal(0n); // Active
		});

		it("increments option counter", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const expiry = chainNow + 600n;

			await sendWithRetry("writeOption #2", () =>
				cc.write.writeOption([ASSETS.testB, ASSETS.testA, 500_000_000n, 2n, expiry], {
					gas: 5_000_000n,
				}),
			);

			const nextId = await cc.read.nextOptionId();
			expect(nextId).to.equal(2n);
		});

		it("rejects zero amount", async function () {
			const chainNow = await getChainTimestamp();
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "writeOption",
					args: [ASSETS.testA, ASSETS.testB, 0n, 1n, chainNow + 600n],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("InvalidAmount") || isContractError(m),
					`expected InvalidAmount or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("rejects past expiry", async function () {
			const chainNow = await getChainTimestamp();
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "writeOption",
					args: [ASSETS.testA, ASSETS.testB, 1_000n, 1n, chainNow - 10n],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("InvalidExpiry") || isContractError(m),
					`expected InvalidExpiry or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		// TODO: support native asset via a wrapped-native (WDOT) ERC20 contract,
		// similar to WETH on Ethereum. Currently rejected because there is no
		// ERC20 precompile address for the native token.
		it("rejects native asset as underlying", async function () {
			const chainNow = await getChainTimestamp();
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "writeOption",
					args: [ASSETS.native, ASSETS.testB, 1_000n, 1n, chainNow + 600n],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("InvalidAsset") || isContractError(m),
					`expected InvalidAsset or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Expire option", function () {
		let expirableOptionId: bigint;

		before(async function () {
			// Write an option with a short expiry (12 seconds — enough for 2-4 blocks
			// depending on block time: 3s local dev, 6s Polkadot production)
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const shortExpiry = chainNow + 12n;

			await sendWithRetry("writeOption (short expiry)", () =>
				cc.write.writeOption([ASSETS.testA, ASSETS.testB, 100_000n, 1n, shortExpiry], {
					gas: 5_000_000n,
				}),
			);

			expirableOptionId = (await cc.read.nextOptionId()) - 1n;
		});

		it("rejects expire before expiry", async function () {
			// The option was just written — should still be active
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "expireOption",
					args: [expirableOptionId],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("OptionNotExpired") || isContractError(m),
					`expected OptionNotExpired or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("expires option after expiry time", async function () {
			// Wait for the short expiry to pass (2-3 blocks)
			for (let i = 0; i < 6; i++) {
				await waitForNextBlock();
			}

			await sendWithRetry("expireOption", () =>
				deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "expireOption",
					args: [expirableOptionId],
					gas: 5_000_000n,
				}),
			);
		});

		it("rejects expiring an already-expired option", async function () {
			await waitForNextBlock();
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "expireOption",
					args: [expirableOptionId],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("OptionNotActive") || isContractError(m),
					`expected OptionNotActive or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Exercise option", function () {
		it("rejects exercising a non-existent option", async function () {
			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "exerciseOption",
					args: [999n],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("OptionNotActive") || isContractError(m),
					`expected OptionNotActive or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});

		it("rejects exercising an expired option", async function () {
			// Write an option with very short expiry, then wait for it to pass
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();

			await sendWithRetry("writeOption (exercise-expired)", () =>
				cc.write.writeOption([ASSETS.testA, ASSETS.testB, 100_000n, 1n, chainNow + 6n], {
					gas: 5_000_000n,
				}),
			);

			const optionId = (await cc.read.nextOptionId()) - 1n;

			// Wait for expiry
			for (let i = 0; i < 6; i++) {
				await waitForNextBlock();
			}

			try {
				await deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "exerciseOption",
					args: [optionId],
					gas: 5_000_000n,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("OptionAlreadyExpired") || isContractError(m),
					`expected OptionAlreadyExpired or revert, got: ${msg.slice(0, 200)}`,
				);
			}
		});
	});

	describe("Fallback", function () {
		it("reverts on unknown selector", async function () {
			try {
				await deployer.sendTransaction({
					to: contractAddress,
					data: "0xdeadbeef",
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				const msg = (e as Error).message;
				expect(msg).to.satisfy(
					(m: string) => m.includes("UnknownSelector") || isContractError(m),
					"expected UnknownSelector or revert error",
				);
			}
		});
	});
});
