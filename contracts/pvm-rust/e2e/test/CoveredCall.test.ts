import { expect } from "chai";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { type Hex, getContract, parseAbi, encodeFunctionData } from "viem";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

// ---------------------------------------------------------------------------
// ABI — matches ICoveredCall in ../CoveredCall.sol
// ---------------------------------------------------------------------------

const coveredCallAbi = parseAbi([
	"function writeOption(bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 premium, uint256 expiry) external returns (uint256)",
	"function buyOption(uint256 optionId) external",
	"function resellOption(uint256 optionId, uint256 askPrice) external",
	"function exerciseOption(uint256 optionId) external",
	"function expireOption(uint256 optionId) external",
	"function getOption(uint256 optionId) external view returns (address seller, bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 premium, uint256 expiry, uint256 created, address buyer, uint256 askPrice, uint256 status)",
	"function nextOptionId() external view returns (uint256)",
	"error PrecompileCallFailed()",
	"error TransferFromFailed()",
	"error OptionNotActive()",
	"error OptionNotListed()",
	"error OptionNotExpired()",
	"error OptionAlreadyExpired()",
	"error NotOptionBuyer()",
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
			if (receipt.status === "reverted") {
				throw new Error(`${label} reverted in block ${receipt.blockNumber}`);
			}
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

// Send a contract call that is expected to revert. Handles both cases:
// 1. viem throws during simulation (eth_call) — caught and verified
// 2. viem sends tx without throwing — receipt status checked for "reverted"
async function expectTxReverts(
	signer: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number],
	params: { address: Hex; functionName: string; args: readonly unknown[] },
	errorName: string,
): Promise<void> {
	const publicClient = await hre.viem.getPublicClient();
	let hash: Hex;
	try {
		hash = await signer.writeContract({
			address: params.address,
			abi: coveredCallAbi,
			functionName: params.functionName,
			args: params.args,
			gas: 5_000_000n,
		} as any);
	} catch (e: unknown) {
		// writeContract threw during simulation — verify it's the expected error
		const msg = (e as Error).message;
		if (msg.includes("execution reverted") && !msg.includes(errorName)) {
			expect.fail(`reverted with wrong error: expected ${errorName}, got: ${msg.slice(0, 300)}`);
		}
		return;
	}
	// writeContract didn't throw — check on-chain receipt
	const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
	expect(receipt.status).to.equal(
		"reverted",
		`expected tx to revert (${errorName}) but it succeeded in block ${receipt.blockNumber}`,
	);
}

// Same as expectTxReverts but for raw sendTransaction (e.g. unknown selector)
async function expectRawTxReverts(
	signer: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number],
	params: { to: Hex; data: Hex },
): Promise<void> {
	const publicClient = await hre.viem.getPublicClient();
	let hash: Hex;
	try {
		hash = await signer.sendTransaction(params);
	} catch (e: unknown) {
		return; // threw during simulation — revert detected
	}
	const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
	expect(receipt.status).to.equal("reverted", `expected tx to revert but it succeeded`);
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
		const timer = setTimeout(
			() => reject(new Error("sendAndWait timed out after 60s")),
			60_000,
		);
		tx.signAndSend(signer, ({ status, dispatchError, events }) => {
			console.log(`        📦 tx status: ${status.type}`);
			if (dispatchError) {
				clearTimeout(timer);
				if (dispatchError.isModule) {
					const decoded = dispatchError.registry.findMetaError(dispatchError.asModule);
					reject(
						new Error(
							`${decoded.section}.${decoded.method}: ${decoded.docs.join(" ")}`,
						),
					);
				} else {
					reject(new Error(dispatchError.toString()));
				}
			} else if (status.isInBlock || status.isFinalized) {
				clearTimeout(timer);
				// Check for dispatch errors in events
				for (const { event } of events || []) {
					if (event.section === "system" && event.method === "ExtrinsicFailed") {
						reject(
							new Error(
								`ExtrinsicFailed in block ${status.isInBlock ? status.asInBlock.toHex() : "finalized"}`,
							),
						);
						return;
					}
				}
				resolve();
			} else if (status.isDropped || status.isInvalid || status.isUsurped) {
				clearTimeout(timer);
				reject(new Error(`Transaction ${status.type}`));
			}
		}).catch((e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

// EVM addresses for dev accounts
const ALICE_ADDR = "0xf24ff3a9cf04c71dbc94d0b566f7a27b94566cac" as Hex;
const BOB_ADDR = "0x3cd0a705a2dc65e5b1e1205896baa2be8a07c6e0" as Hex;
const CHARLIE_ADDR = "0x6F0B38B28Cd0D6Db363c9B7Bd4Ec67D1626E17FA" as Hex;

async function ensureTestAssets(): Promise<void> {
	const wsUrl = process.env.WS_URL || "ws://127.0.0.1:9944";
	const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
	const keyring = new Keyring({ type: "sr25519" });
	const alice = keyring.addFromUri("//Alice");
	const mintAmount = 1_000_000_000_000_000n;

	const evmAccounts = [ALICE_ADDR, BOB_ADDR, CHARLIE_ADDR].map(evmToSubstrateAccount);

	try {
		for (const assetId of [1, 2]) {
			console.log(`        🔧 checking asset ${assetId}...`);
			const existing = await api.query.assets.asset(assetId);
			if (existing.isEmpty) {
				console.log(`        🔧 creating asset ${assetId}...`);
				await sendAndWait(api.tx.assets.create(assetId, alice.address, 1), alice);
			} else {
				console.log(`        🔧 asset ${assetId} already exists`);
			}

			const pending: Array<{ assetId: number; idx: number; addr: string }> = [];
			for (let i = 0; i < evmAccounts.length; i++) {
				const balance = await api.query.assets.account(assetId, evmAccounts[i]);
				if (balance.isEmpty) {
					pending.push({ assetId, idx: i, addr: evmAccounts[i] });
				} else {
					console.log(`        🔧 account ${i} already has asset ${assetId}`);
				}
			}
			if (pending.length > 0) {
				// Batch all mints into a single extrinsic to avoid nonce races
				const calls = pending.map(({ assetId: id, addr }) =>
					api.tx.assets.mint(id, addr, mintAmount),
				);
				console.log(
					`        🔧 batch minting asset ${assetId} to ${pending.map((p) => p.idx).join(",")}...`,
				);
				await sendAndWait(
					calls.length === 1 ? calls[0] : api.tx.utility.batchAll(calls),
					alice,
				);
			}
		}
		console.log(`        🔧 ensureTestAssets done`);
	} finally {
		await api.disconnect();
	}
}

// Status constants matching the contract
const STATUS_LISTED = 0n;
const STATUS_ACTIVE = 1n;
const STATUS_EXERCISED = 2n;
const STATUS_EXPIRED = 3n;
const STATUS_RESALE = 4n;

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
			firstOptionExpiry = chainNow + 600n;

			firstOptionId = await cc.read.nextOptionId();
			const aliceTSTAbefore = await getERC20Balance(ERC20_TSTA, deployer.account.address);

			await sendWithRetry("writeOption", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, 1_000_000_000n, 1n, 500n, firstOptionExpiry],
					{ gas: 5_000_000n },
				),
			);

			const idAfter = await cc.read.nextOptionId();
			expect(idAfter).to.equal(firstOptionId + 1n);

			// Seller's underlying balance decreased by the collateral amount
			const aliceTSTAafter = await getERC20Balance(ERC20_TSTA, deployer.account.address);
			expect(aliceTSTAbefore - aliceTSTAafter).to.equal(1_000_000_000n);
		});

		it("stores correct option data with Listed status", async function () {
			const [
				seller,
				underlying,
				strikeAsset,
				amount,
				strikePrice,
				premium,
				expiry,
				created,
				buyer,
				askPrice,
				status,
			] = await cc.read.getOption([firstOptionId]);

			expect(seller.toLowerCase()).to.equal(deployer.account.address.toLowerCase());
			expect(underlying.toLowerCase()).to.equal(ASSETS.testA.toLowerCase());
			expect(strikeAsset.toLowerCase()).to.equal(ASSETS.testB.toLowerCase());
			expect(amount).to.equal(1_000_000_000n);
			expect(strikePrice).to.equal(1n);
			expect(premium).to.equal(500n);
			expect(expiry).to.equal(firstOptionExpiry);
			expect(created > 0n).to.equal(true, "created should be > 0");
			expect(created <= firstOptionExpiry).to.equal(true, "created should be <= expiry");
			// No buyer yet — zero address
			expect(buyer.toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");
			expect(askPrice).to.equal(0n);
			expect(status).to.equal(STATUS_LISTED);
		});

		it("rejects zero amount", async function () {
			const chainNow = await getChainTimestamp();
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "writeOption",
					args: [ASSETS.testA, ASSETS.testB, 0n, 1n, 100n, chainNow + 600n],
				},
				"InvalidAmount",
			);
		});

		it("rejects past expiry", async function () {
			const chainNow = await getChainTimestamp();
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "writeOption",
					args: [ASSETS.testA, ASSETS.testB, 1_000n, 1n, 100n, chainNow - 10n],
				},
				"InvalidExpiry",
			);
		});

		// TODO: support native asset via a wrapped-native (WDOT) ERC20 contract,
		// similar to WETH on Ethereum. Currently rejected because there is no
		// ERC20 precompile address for the native token.
		it("rejects native asset as underlying", async function () {
			const chainNow = await getChainTimestamp();
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "writeOption",
					args: [ASSETS.native, ASSETS.testB, 1_000n, 1n, 100n, chainNow + 600n],
				},
				"InvalidAsset",
			);
		});
	});

	describe("Buy option", function () {
		let buyableOptionId: bigint;

		before(async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();

			await sendWithRetry("writeOption (buyable)", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, 100_000n, 1n, 200n, chainNow + 600n],
					{ gas: 5_000_000n },
				),
			);

			buyableOptionId = (await cc.read.nextOptionId()) - 1n;
		});

		it("buys a listed option and sets status to Active", async function () {
			await waitForNextBlock();

			await sendWithRetry("buyOption", () =>
				cc.write.buyOption([buyableOptionId], { gas: 5_000_000n }),
			);

			const [, , , , , , , , buyer, , status] = await cc.read.getOption([buyableOptionId]);
			expect(buyer.toLowerCase()).to.equal(deployer.account.address.toLowerCase());
			expect(status).to.equal(STATUS_ACTIVE);
		});

		it("rejects buying an already-bought option", async function () {
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "buyOption",
					args: [buyableOptionId],
				},
				"OptionNotListed",
			);
		});
	});

	describe("Expire option", function () {
		let longExpiryOptionId: bigint;
		let shortExpiryOptionId: bigint;

		before(async function () {
			// Long-expiry option for "rejects before expiry" test
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();

			await sendWithRetry("writeOption (long expiry)", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, 100_000n, 1n, 0n, chainNow + 600n],
					{ gas: 5_000_000n },
				),
			);
			longExpiryOptionId = (await cc.read.nextOptionId()) - 1n;
		});

		it("rejects expire before expiry", async function () {
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "expireOption",
					args: [longExpiryOptionId],
				},
				"OptionNotExpired",
			);
		});

		it("expires option after expiry time", async function () {
			// Write a separate option with short expiry for this test
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const collateralAmount = 50_000n;

			await sendWithRetry("writeOption (short expiry)", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, collateralAmount, 1n, 0n, chainNow + 15n],
					{ gas: 5_000_000n },
				),
			);
			shortExpiryOptionId = (await cc.read.nextOptionId()) - 1n;

			// Wait for expiry to pass (~15s at 3s/block = 5 blocks, wait 8 for margin)
			for (let i = 0; i < 8; i++) {
				await waitForNextBlock();
			}

			const aliceTSTAbefore = await getERC20Balance(ERC20_TSTA, deployer.account.address);

			await sendWithRetry("expireOption", () =>
				deployer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "expireOption",
					args: [shortExpiryOptionId],
					gas: 5_000_000n,
				}),
			);

			// expire_option clears all storage slots, so getOption returns zeros.
			const [seller] = await cc.read.getOption([shortExpiryOptionId]);
			expect(seller.toLowerCase()).to.equal("0x0000000000000000000000000000000000000000");

			// Seller gets collateral back
			const aliceTSTAafter = await getERC20Balance(ERC20_TSTA, deployer.account.address);
			expect(aliceTSTAafter - aliceTSTAbefore).to.equal(collateralAmount);
		});

		it("rejects expiring an already-expired option", async function () {
			await waitForNextBlock();
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "expireOption",
					args: [shortExpiryOptionId],
				},
				"OptionNotActive",
			);
		});
	});

	describe("Exercise option", function () {
		it("rejects exercising a non-existent option", async function () {
			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "exerciseOption",
					args: [999n],
				},
				"OptionNotActive",
			);
		});

		it("rejects exercising a listed (not bought) option", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();

			await sendWithRetry("writeOption (listed-only)", () =>
				cc.write.writeOption(
					[ASSETS.testA, ASSETS.testB, 100_000n, 1n, 0n, chainNow + 600n],
					{ gas: 5_000_000n },
				),
			);

			const optionId = (await cc.read.nextOptionId()) - 1n;

			await expectTxReverts(
				deployer,
				{
					address: contractAddress,
					functionName: "exerciseOption",
					args: [optionId],
				},
				"OptionNotActive",
			);
		});
	});

	describe("Fallback", function () {
		it("reverts on unknown selector", async function () {
			await expectRawTxReverts(deployer, {
				to: contractAddress,
				data: "0xdeadbeef" as Hex,
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle tests — multi-account scenarios with DEX interaction.
// These test the complete options flow: pool setup, write, buy, exercise/expire.
// Requires Substrate node (:9944) and eth-rpc proxy (:8545).
// ---------------------------------------------------------------------------

const PRECOMPILE = "0x0000000000000000000000000000000004200000" as Hex;

const assetConversionAbi = parseAbi([
	"function createPool(bytes asset1, bytes asset2) external",
	"function addLiquidity(bytes asset1, bytes asset2, uint256 amount1Desired, uint256 amount2Desired, uint256 amount1Min, uint256 amount2Min, address mintTo) external returns (uint256)",
	"function swapExactTokensForTokens(bytes[] path, uint256 amountIn, uint256 amountOutMin, address sendTo) external returns (uint256)",
	"function quoteExactTokensForTokens(bytes asset1, bytes asset2, uint256 amount, bool includeFee) external view returns (uint256)",
]);

async function getWalletClientByIndex(index: number) {
	const clients = await hre.viem.getWalletClients();
	if (!clients[index]) {
		throw new Error(
			`No wallet client at index ${index}. Add more accounts to hardhat.config.ts`,
		);
	}
	return clients[index];
}

async function approveERC20As(
	signerIndex: number,
	erc20Address: Hex,
	spender: Hex,
	amount: bigint,
) {
	const signer = await getWalletClientByIndex(signerIndex);
	await sendWithRetry(`approve[${signerIndex}]`, () =>
		signer.writeContract({
			address: erc20Address,
			abi: erc20Abi,
			functionName: "approve",
			args: [spender, amount],
			gas: 5_000_000n,
		}),
	);
}

async function createPoolIfNeeded(asset1: Hex, asset2: Hex) {
	const [alice] = await hre.viem.getWalletClients();
	try {
		await sendWithRetry("createPool", () =>
			alice.writeContract({
				address: PRECOMPILE,
				abi: assetConversionAbi,
				functionName: "createPool",
				args: [asset1, asset2],
			}),
		);
	} catch (e: unknown) {
		// Pool creation failed — verify it's because the pool already exists
		// by checking that a quote succeeds. If the pool doesn't exist,
		// the quote will throw and we re-throw the original error.
		try {
			await getDexQuote(asset1, asset2, 1_000n);
			console.log("        ℹ️  pool already exists, continuing");
		} catch {
			throw e; // pool doesn't exist — original error is real
		}
	}
}

async function addLiquidity(asset1: Hex, asset2: Hex, amount1: bigint, amount2: bigint) {
	const [alice] = await hre.viem.getWalletClients();
	const data = encodeFunctionData({
		abi: assetConversionAbi,
		functionName: "addLiquidity",
		args: [asset1, asset2, amount1, amount2, 0n, 0n, alice.account.address],
	});
	await sendWithRetry("addLiquidity", () =>
		alice.sendTransaction({
			to: PRECOMPILE,
			data,
			gas: 5_000_000n,
		}),
	);
}

async function getDexQuote(assetIn: Hex, assetOut: Hex, amountIn: bigint): Promise<bigint> {
	const publicClient = await hre.viem.getPublicClient();
	return publicClient.readContract({
		address: PRECOMPILE,
		abi: assetConversionAbi,
		functionName: "quoteExactTokensForTokens",
		args: [assetIn, assetOut, amountIn, true],
	}) as Promise<bigint>;
}

// Convert SCALE-encoded asset hex to NativeOrWithId enum for @polkadot/api
function toNativeOrWithId(scaleHex: Hex): object | string {
	if (scaleHex === "0x00") {
		return "Native";
	}
	// WithId(id): 0x01 + u32_le
	const idBytes = scaleHex.slice(4); // skip "0x01"
	const id =
		parseInt(idBytes.slice(0, 2), 16) +
		(parseInt(idBytes.slice(2, 4), 16) << 8) +
		(parseInt(idBytes.slice(4, 6), 16) << 16) +
		(parseInt(idBytes.slice(6, 8), 16) << 24);
	return { WithId: id };
}

async function swapExact(signerIndex: number, path: Hex[], amountIn: bigint) {
	// Use Substrate RPC extrinsic instead of precompile — the precompile's
	// swapExactTokensForTokens reverts when called directly (not via contract).
	const wsUrl = process.env.WS_URL || "ws://127.0.0.1:9944";
	const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
	const keyring = new Keyring({ type: "sr25519" });
	const signerNames = ["//Alice", "//Bob", "//Charlie"];
	const signer = keyring.addFromUri(signerNames[signerIndex]);

	const assetPath = path.map(toNativeOrWithId);
	console.log(`        💱 swap ${amountIn} via substrate extrinsic`);

	try {
		await sendAndWait(
			api.tx.assetConversion.swapExactTokensForTokens(
				assetPath,
				amountIn,
				1, // amountOutMin
				signer.address,
				false, // keepAlive
			),
			signer,
		);
		console.log(`        ✅ swap confirmed`);
	} finally {
		await api.disconnect();
	}
}

async function getERC20Balance(erc20Address: Hex, account: Hex): Promise<bigint> {
	const publicClient = await hre.viem.getPublicClient();
	return publicClient.readContract({
		address: erc20Address,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [account],
	}) as Promise<bigint>;
}

function ccAs(signerIndex: number, contractAddress: Hex) {
	return {
		async writeOption(
			underlying: Hex,
			strikeAsset: Hex,
			amount: bigint,
			strikePrice: bigint,
			premium: bigint,
			expiry: bigint,
		) {
			const signer = await getWalletClientByIndex(signerIndex);
			await sendWithRetry(`writeOption[${signerIndex}]`, () =>
				signer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "writeOption",
					args: [underlying, strikeAsset, amount, strikePrice, premium, expiry],
					gas: 5_000_000n,
				}),
			);
		},
		async buyOption(optionId: bigint) {
			const signer = await getWalletClientByIndex(signerIndex);
			await sendWithRetry(`buyOption[${signerIndex}]`, () =>
				signer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "buyOption",
					args: [optionId],
					gas: 5_000_000n,
				}),
			);
		},
		async resellOption(optionId: bigint, askPrice: bigint) {
			const signer = await getWalletClientByIndex(signerIndex);
			await sendWithRetry(`resellOption[${signerIndex}]`, () =>
				signer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "resellOption",
					args: [optionId, askPrice],
					gas: 5_000_000n,
				}),
			);
		},
		async exerciseOption(optionId: bigint) {
			const signer = await getWalletClientByIndex(signerIndex);
			await sendWithRetry(`exerciseOption[${signerIndex}]`, () =>
				signer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "exerciseOption",
					args: [optionId],
					gas: 5_000_000n,
				}),
			);
		},
		async expireOption(optionId: bigint) {
			const signer = await getWalletClientByIndex(signerIndex);
			await sendWithRetry(`expireOption[${signerIndex}]`, () =>
				signer.writeContract({
					address: contractAddress,
					abi: coveredCallAbi,
					functionName: "expireOption",
					args: [optionId],
					gas: 5_000_000n,
				}),
			);
		},
	};
}

// Account indices: Alice=0, Bob=1, Charlie=2

describe("CoveredCall full lifecycle", function () {
	this.timeout(300_000);

	let contractAddress: Hex;
	const ALICE = 0,
		BOB = 1,
		CHARLIE = 2;
	const POOL_AMOUNT = 100_000_000_000n; // 100e9
	const OPTION_AMOUNT = 1_000_000_000n; // 1e9

	before(async function () {
		// Reuse the shared deployment
		contractAddress = sharedAddress;

		// Ensure Bob and Charlie have test assets
		await ensureTestAssets();
		await waitForNextBlock();

		// Create TSTA↔TSTB pool and add liquidity (Alice)
		await createPoolIfNeeded(ASSETS.testA, ASSETS.testB);
		await waitForNextBlock();

		// Approve precompile to spend Alice's TSTA for liquidity
		await approveERC20As(ALICE, ERC20_TSTA, PRECOMPILE, 1_000_000_000_000n);
		await waitForNextBlock();
		await approveERC20As(ALICE, ERC20_TSTB, PRECOMPILE, 1_000_000_000_000n);
		await waitForNextBlock();

		await addLiquidity(ASSETS.testA, ASSETS.testB, POOL_AMOUNT, POOL_AMOUNT);
		await waitForNextBlock();

		// Approve CoveredCall contract for all three accounts
		for (const idx of [ALICE, BOB, CHARLIE]) {
			await approveERC20As(idx, ERC20_TSTA, contractAddress, 100_000_000_000_000n);
			await waitForNextBlock();
			await approveERC20As(idx, ERC20_TSTB, contractAddress, 100_000_000_000_000n);
			await waitForNextBlock();
		}

		// Approve precompile for Bob and Charlie (for swaps)
		for (const idx of [BOB, CHARLIE]) {
			await approveERC20As(idx, ERC20_TSTA, PRECOMPILE, 1_000_000_000_000n);
			await waitForNextBlock();
			await approveERC20As(idx, ERC20_TSTB, PRECOMPILE, 1_000_000_000_000n);
			await waitForNextBlock();
		}
	});

	// Scenario 1: Alice writes, Bob buys, Alice swaps to move price, Bob exercises ITM
	describe("Scenario 1: write → buy → swap → exercise ITM", function () {
		let optionId: bigint;

		it("1. Alice writes a covered call (TSTA underlying, TSTB strike)", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const expiry = chainNow + 600n;

			const idBefore = await sharedContract.read.nextOptionId();
			await ccAs(ALICE, contractAddress).writeOption(
				ASSETS.testA,
				ASSETS.testB,
				OPTION_AMOUNT,
				1n,
				500n,
				expiry,
			);
			optionId = idBefore;

			const [seller, , , , , , , , , , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(seller.toLowerCase()).to.equal(ALICE_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_LISTED);
		});

		it("2. Bob buys the option (pays premium)", async function () {
			await waitForNextBlock();

			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(BOB, contractAddress).buyOption(optionId);

			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			// Bob pays premium (500 TSTB) to Alice
			expect(bobTSTBbefore - bobTSTBafter).to.equal(500n);
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(500n);

			const [, , , , , , , , buyer, , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(buyer.toLowerCase()).to.equal(BOB_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_ACTIVE);
		});

		it("3. Alice swaps TSTB→TSTA to increase TSTA price (make option ITM)", async function () {
			await waitForNextBlock();
			const quoteBefore = await getDexQuote(ASSETS.testA, ASSETS.testB, OPTION_AMOUNT);
			// Large swap: push lots of TSTB into the pool, making TSTA more expensive
			const swapAmount = POOL_AMOUNT / 5n; // 20% of pool — enough to skew price
			await swapExact(ALICE, [ASSETS.testB, ASSETS.testA], swapAmount);
			const quoteAfter = await getDexQuote(ASSETS.testA, ASSETS.testB, OPTION_AMOUNT);
			expect(quoteAfter > quoteBefore).to.equal(
				true,
				`Expected TSTA price to increase: ${quoteBefore} → ${quoteAfter}`,
			);
		});

		it("4. Bob exercises the option (ITM)", async function () {
			await waitForNextBlock();

			const bobTSTAbefore = await getERC20Balance(ERC20_TSTA, BOB_ADDR);
			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(BOB, contractAddress).exerciseOption(optionId);

			const bobTSTAafter = await getERC20Balance(ERC20_TSTA, BOB_ADDR);
			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			// Bob receives the underlying TSTA
			expect(bobTSTAafter - bobTSTAbefore).to.equal(OPTION_AMOUNT);
			// Bob pays strikePrice * amount of TSTB to seller
			const strikeCost = 1n * OPTION_AMOUNT;
			expect(bobTSTBbefore - bobTSTBafter).to.equal(strikeCost);
			// Alice (seller) receives the strike payment
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(strikeCost);

			const [, , , , , , , , , , status] = await sharedContract.read.getOption([optionId]);
			expect(status).to.equal(STATUS_EXERCISED);
		});
	});

	// Scenario 2: Alice writes, Bob buys, Bob resells to Charlie, Charlie exercises
	describe("Scenario 2: write → buy → resell → Charlie exercises", function () {
		let optionId: bigint;

		it("1. Alice writes a covered call", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const expiry = chainNow + 600n;

			const idBefore = await sharedContract.read.nextOptionId();
			await ccAs(ALICE, contractAddress).writeOption(
				ASSETS.testA,
				ASSETS.testB,
				OPTION_AMOUNT,
				1n,
				500n,
				expiry,
			);
			optionId = idBefore;

			const idAfter = await sharedContract.read.nextOptionId();
			expect(idAfter).to.equal(optionId + 1n);
			const [seller, , , , , , , , , , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(seller.toLowerCase()).to.equal(ALICE_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_LISTED);
		});

		it("2. Bob buys the option (pays premium to Alice)", async function () {
			await waitForNextBlock();

			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(BOB, contractAddress).buyOption(optionId);

			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			expect(bobTSTBbefore - bobTSTBafter).to.equal(500n);
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(500n);

			const [, , , , , , , , buyer, , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(buyer.toLowerCase()).to.equal(BOB_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_ACTIVE);
		});

		it("3. Bob resells the option to the secondary market", async function () {
			await waitForNextBlock();
			await ccAs(BOB, contractAddress).resellOption(optionId, 300n);

			const [, , , , , , , , , askPrice, status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(status).to.equal(STATUS_RESALE);
			expect(askPrice).to.equal(300n);
		});

		it("4. Charlie buys the resold option (pays ask price to Bob)", async function () {
			await waitForNextBlock();

			const charlieTSTBbefore = await getERC20Balance(ERC20_TSTB, CHARLIE_ADDR);
			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);

			await ccAs(CHARLIE, contractAddress).buyOption(optionId);

			const charlieTSTBafter = await getERC20Balance(ERC20_TSTB, CHARLIE_ADDR);
			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);

			// Charlie pays 300 TSTB ask price to Bob
			expect(charlieTSTBbefore - charlieTSTBafter).to.equal(300n);
			expect(bobTSTBafter - bobTSTBbefore).to.equal(300n);

			const [, , , , , , , , buyer, askPrice, status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(buyer.toLowerCase()).to.equal(CHARLIE_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_ACTIVE);
			expect(askPrice).to.equal(0n);
		});

		it("5. Charlie exercises the option", async function () {
			await waitForNextBlock();

			const charlieTSTAbefore = await getERC20Balance(ERC20_TSTA, CHARLIE_ADDR);
			const charlieTSTBbefore = await getERC20Balance(ERC20_TSTB, CHARLIE_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(CHARLIE, contractAddress).exerciseOption(optionId);

			const charlieTSTAafter = await getERC20Balance(ERC20_TSTA, CHARLIE_ADDR);
			const charlieTSTBafter = await getERC20Balance(ERC20_TSTB, CHARLIE_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			// Charlie receives underlying TSTA
			expect(charlieTSTAafter - charlieTSTAbefore).to.equal(OPTION_AMOUNT);
			// Charlie pays strike cost to Alice
			const strikeCost = 1n * OPTION_AMOUNT;
			expect(charlieTSTBbefore - charlieTSTBafter).to.equal(strikeCost);
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(strikeCost);

			const [, , , , , , , , , , status] = await sharedContract.read.getOption([optionId]);
			expect(status).to.equal(STATUS_EXERCISED);
		});
	});

	// Scenario 3: Alice swaps to move price first, then writes an option already ITM
	describe("Scenario 3: swap first → write already-ITM option → buy → exercise", function () {
		let optionId: bigint;

		it("1. Alice swaps more TSTB→TSTA to ensure TSTA is expensive", async function () {
			await waitForNextBlock();
			const quoteBefore = await getDexQuote(ASSETS.testA, ASSETS.testB, OPTION_AMOUNT);
			const swapAmount = POOL_AMOUNT / 5n;
			await swapExact(ALICE, [ASSETS.testB, ASSETS.testA], swapAmount);
			const quoteAfter = await getDexQuote(ASSETS.testA, ASSETS.testB, OPTION_AMOUNT);
			expect(quoteAfter > quoteBefore).to.equal(
				true,
				`Expected price to increase: ${quoteBefore} → ${quoteAfter}`,
			);
		});

		it("2. Verify TSTA is worth more than 1 TSTB (already ITM for strike=1)", async function () {
			await waitForNextBlock();
			const quote = await getDexQuote(ASSETS.testA, ASSETS.testB, OPTION_AMOUNT);
			// Market value should exceed strike cost (1 * OPTION_AMOUNT)
			expect(quote > OPTION_AMOUNT).to.equal(
				true,
				`Expected quote ${quote} > strike cost ${OPTION_AMOUNT}`,
			);
		});

		it("3. Alice writes a call that is already in-the-money", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const expiry = chainNow + 600n;

			const idBefore = await sharedContract.read.nextOptionId();
			await ccAs(ALICE, contractAddress).writeOption(
				ASSETS.testA,
				ASSETS.testB,
				OPTION_AMOUNT,
				1n,
				100n,
				expiry,
			);
			optionId = idBefore;

			const [seller, , , , , , , , , , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(seller.toLowerCase()).to.equal(ALICE_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_LISTED);
		});

		it("4. Bob buys and immediately exercises (already ITM)", async function () {
			await waitForNextBlock();
			await ccAs(BOB, contractAddress).buyOption(optionId);
			await waitForNextBlock();

			// Snapshot AFTER buy so premium is excluded from exercise delta
			const bobTSTAbefore = await getERC20Balance(ERC20_TSTA, BOB_ADDR);
			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(BOB, contractAddress).exerciseOption(optionId);

			const bobTSTAafter = await getERC20Balance(ERC20_TSTA, BOB_ADDR);
			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			// Bob receives underlying
			expect(bobTSTAafter - bobTSTAbefore).to.equal(OPTION_AMOUNT);
			// Bob pays strike cost
			const strikeCost = 1n * OPTION_AMOUNT;
			expect(bobTSTBbefore - bobTSTBafter).to.equal(strikeCost);
			// Alice receives strike payment
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(strikeCost);

			const [, , , , , , , , , , status] = await sharedContract.read.getOption([optionId]);
			expect(status).to.equal(STATUS_EXERCISED);
		});
	});

	// Scenario 4: Alice writes, Bob buys, Bob tries to exercise OTM → fails
	describe("Scenario 4: write → buy → exercise OTM (should fail)", function () {
		let optionId: bigint;

		before(async function () {
			// Reset pool balance: swap TSTA back into the pool so price normalizes
			await waitForNextBlock();
			const swapAmount = POOL_AMOUNT / 5n;
			await swapExact(ALICE, [ASSETS.testA, ASSETS.testB], swapAmount);
		});

		it("1. Alice writes a call with a high strike price (OTM)", async function () {
			await waitForNextBlock();
			const chainNow = await getChainTimestamp();
			const expiry = chainNow + 600n;

			// Strike price so high the option can never be ITM with current pool
			const idBefore = await sharedContract.read.nextOptionId();
			await ccAs(ALICE, contractAddress).writeOption(
				ASSETS.testA,
				ASSETS.testB,
				OPTION_AMOUNT,
				1000n,
				100n,
				expiry,
			);
			optionId = idBefore;

			const [seller, , , , strikePrice, , , , , , status] =
				await sharedContract.read.getOption([optionId]);
			expect(seller.toLowerCase()).to.equal(ALICE_ADDR.toLowerCase());
			expect(strikePrice).to.equal(1000n);
			expect(status).to.equal(STATUS_LISTED);
		});

		it("2. Bob buys the option (pays premium)", async function () {
			await waitForNextBlock();

			const bobTSTBbefore = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBbefore = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			await ccAs(BOB, contractAddress).buyOption(optionId);

			const bobTSTBafter = await getERC20Balance(ERC20_TSTB, BOB_ADDR);
			const aliceTSTBafter = await getERC20Balance(ERC20_TSTB, ALICE_ADDR);

			// Bob pays 100 TSTB premium to Alice
			expect(bobTSTBbefore - bobTSTBafter).to.equal(100n);
			expect(aliceTSTBafter - aliceTSTBbefore).to.equal(100n);

			const [, , , , , , , , buyer, , status] = await sharedContract.read.getOption([
				optionId,
			]);
			expect(buyer.toLowerCase()).to.equal(BOB_ADDR.toLowerCase());
			expect(status).to.equal(STATUS_ACTIVE);
		});

		it("3. Bob tries to exercise but option is OTM → reverts", async function () {
			await waitForNextBlock();
			const bob = await getWalletClientByIndex(BOB);
			await expectTxReverts(
				bob,
				{
					address: contractAddress,
					functionName: "exerciseOption",
					args: [optionId],
				},
				"NotInTheMoney",
			);
		});
	});
});
