import { expect } from "chai";
import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { type Hex, getContract, parseAbi, keccak256, toHex } from "viem";

// ---------------------------------------------------------------------------
// ABI — matches IVersionRegistry in ../VersionRegistry.sol
// ---------------------------------------------------------------------------

const registryAbi = parseAbi([
	"function registerVersion(bytes32 name, address implementation) external returns (uint256)",
	"function transferOwnership(address newOwner) external",
	"function latest(bytes32 name) external view returns (address)",
	"function getVersion(bytes32 name, uint256 version) external view returns (address)",
	"function versionCount(bytes32 name) external view returns (uint256)",
	"function owner() external view returns (address)",
	"error NotOwner()",
	"error InvalidAddress()",
	"error VersionNotFound()",
	"error UnknownSelector()",
]);

// Contract family names as bytes32
const NAME_COVERED_CALL = keccak256(toHex("covered-call"));
const NAME_FUTURES = keccak256(toHex("futures"));

// ---------------------------------------------------------------------------
// PVM bytecode loader
// ---------------------------------------------------------------------------

function loadBytecode(): Hex {
	const pvmPath = path.resolve(__dirname, "../../target/version-registry.release.polkavm");
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
			abi: registryAbi,
			functionName: params.functionName,
			args: params.args,
			gas: 5_000_000n,
		} as any);
	} catch (e: unknown) {
		const msg = (e as Error).message;
		if (msg.includes("execution reverted") && !msg.includes(errorName)) {
			expect.fail(
				`reverted with wrong error: expected ${errorName}, got: ${msg.slice(0, 300)}`,
			);
		}
		return;
	}
	const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
	expect(receipt.status).to.equal(
		"reverted",
		`expected tx to revert (${errorName}) but it succeeded in block ${receipt.blockNumber}`,
	);
}

// Fake implementation addresses
const IMPL_CC_V1 = "0x1111111111111111111111111111111111111111" as Hex;
const IMPL_CC_V2 = "0x2222222222222222222222222222222222222222" as Hex;
const IMPL_FUT_V1 = "0x3333333333333333333333333333333333333333" as Hex;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VersionRegistry (PVM-Rust)", function () {
	this.timeout(120_000);

	let registry: any;
	let deployer: Awaited<ReturnType<typeof hre.viem.getWalletClients>>[number];
	let registryAddress: Hex;

	before(async function () {
		await waitForNextBlock();

		const [dep] = await hre.viem.getWalletClients();
		deployer = dep;
		const publicClient = await hre.viem.getPublicClient();
		const bytecode = loadBytecode();

		const receipt = await sendWithRetry("deploy registry", () =>
			deployer.deployContract({ abi: registryAbi, bytecode }),
		);

		if (!receipt.contractAddress) {
			throw new Error("Deploy did not create a contract");
		}

		registryAddress = receipt.contractAddress as Hex;
		registry = getContract({
			address: registryAddress,
			abi: registryAbi,
			client: { public: publicClient, wallet: deployer },
		});
	});

	describe("Deployment", function () {
		it("sets deployer as owner", async function () {
			const o = await registry.read.owner();
			expect((o as string).toLowerCase()).to.equal(deployer.account.address.toLowerCase());
		});

		it("starts with zero versions for any name", async function () {
			const cc = await registry.read.versionCount([NAME_COVERED_CALL]);
			const ft = await registry.read.versionCount([NAME_FUTURES]);
			expect(cc).to.equal(0n);
			expect(ft).to.equal(0n);
		});

		it("latest returns zero address for unregistered name", async function () {
			const addr = await registry.read.latest([NAME_COVERED_CALL]);
			expect((addr as string).toLowerCase()).to.equal(ZERO_ADDR);
		});
	});

	describe("Register versions", function () {
		it("registers covered-call v1", async function () {
			await waitForNextBlock();
			await sendWithRetry("registerVersion(cc v1)", () =>
				registry.write.registerVersion([NAME_COVERED_CALL, IMPL_CC_V1], {
					gas: 5_000_000n,
				}),
			);

			const count = await registry.read.versionCount([NAME_COVERED_CALL]);
			expect(count).to.equal(1n);

			const addr = await registry.read.getVersion([NAME_COVERED_CALL, 1n]);
			expect((addr as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());

			const lat = await registry.read.latest([NAME_COVERED_CALL]);
			expect((lat as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());
		});

		it("registers covered-call v2 and updates latest", async function () {
			await waitForNextBlock();
			await sendWithRetry("registerVersion(cc v2)", () =>
				registry.write.registerVersion([NAME_COVERED_CALL, IMPL_CC_V2], {
					gas: 5_000_000n,
				}),
			);

			const count = await registry.read.versionCount([NAME_COVERED_CALL]);
			expect(count).to.equal(2n);

			const lat = await registry.read.latest([NAME_COVERED_CALL]);
			expect((lat as string).toLowerCase()).to.equal(IMPL_CC_V2.toLowerCase());

			// v1 still accessible
			const v1 = await registry.read.getVersion([NAME_COVERED_CALL, 1n]);
			expect((v1 as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());
		});

		it("registers futures v1 independently", async function () {
			await waitForNextBlock();
			await sendWithRetry("registerVersion(futures v1)", () =>
				registry.write.registerVersion([NAME_FUTURES, IMPL_FUT_V1], {
					gas: 5_000_000n,
				}),
			);

			// Futures has 1 version
			const ftCount = await registry.read.versionCount([NAME_FUTURES]);
			expect(ftCount).to.equal(1n);

			const ftLatest = await registry.read.latest([NAME_FUTURES]);
			expect((ftLatest as string).toLowerCase()).to.equal(IMPL_FUT_V1.toLowerCase());

			// Covered-call still has 2 — independent chains
			const ccCount = await registry.read.versionCount([NAME_COVERED_CALL]);
			expect(ccCount).to.equal(2n);
		});

		it("rejects zero address", async function () {
			await waitForNextBlock();
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "registerVersion",
					args: [NAME_COVERED_CALL, ZERO_ADDR],
				},
				"InvalidAddress",
			);
		});

		it("rejects non-owner", async function () {
			const clients = await hre.viem.getWalletClients();
			if (clients.length < 2) {
				this.skip();
				return;
			}
			const bob = clients[1];
			await waitForNextBlock();
			await expectTxReverts(
				bob,
				{
					address: registryAddress,
					functionName: "registerVersion",
					args: [NAME_COVERED_CALL, IMPL_CC_V1],
				},
				"NotOwner",
			);
		});
	});

	describe("Get version", function () {
		it("rejects version 0", async function () {
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "getVersion",
					args: [NAME_COVERED_CALL, 0n],
				},
				"VersionNotFound",
			);
		});

		it("rejects version at exact boundary (count + 1)", async function () {
			const count = await registry.read.versionCount([NAME_COVERED_CALL]);
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "getVersion",
					args: [NAME_COVERED_CALL, (count as bigint) + 1n],
				},
				"VersionNotFound",
			);
		});

		it("rejects any version for unregistered name", async function () {
			const unknownName = keccak256(toHex("unknown-contract"));
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "getVersion",
					args: [unknownName, 1n],
				},
				"VersionNotFound",
			);
		});
	});

	describe("Edge cases", function () {
		it("allows registering the same implementation address as a new version", async function () {
			await waitForNextBlock();
			const countBefore = (await registry.read.versionCount([NAME_COVERED_CALL])) as bigint;

			await sendWithRetry("registerVersion (duplicate addr)", () =>
				registry.write.registerVersion([NAME_COVERED_CALL, IMPL_CC_V1], {
					gas: 5_000_000n,
				}),
			);

			const countAfter = (await registry.read.versionCount([NAME_COVERED_CALL])) as bigint;
			expect(countAfter).to.equal(countBefore + 1n);

			// Both the old and new version point to the same address
			const oldV = await registry.read.getVersion([NAME_COVERED_CALL, 1n]);
			const newV = await registry.read.getVersion([NAME_COVERED_CALL, countAfter]);
			expect((oldV as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());
			expect((newV as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());
		});

		it("allows transferring ownership to self (no-op)", async function () {
			await waitForNextBlock();
			await sendWithRetry("transferOwnership (to self)", () =>
				registry.write.transferOwnership([deployer.account.address], {
					gas: 5_000_000n,
				}),
			);

			const o = await registry.read.owner();
			expect((o as string).toLowerCase()).to.equal(deployer.account.address.toLowerCase());
		});
	});

	describe("Transfer ownership", function () {
		it("rejects non-owner", async function () {
			const clients = await hre.viem.getWalletClients();
			if (clients.length < 2) {
				this.skip();
				return;
			}
			const bob = clients[1];
			await waitForNextBlock();
			await expectTxReverts(
				bob,
				{
					address: registryAddress,
					functionName: "transferOwnership",
					args: [bob.account.address],
				},
				"NotOwner",
			);
		});

		it("rejects zero address", async function () {
			await waitForNextBlock();
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "transferOwnership",
					args: [ZERO_ADDR],
				},
				"InvalidAddress",
			);
		});

		it("transfers ownership and new owner can register", async function () {
			const clients = await hre.viem.getWalletClients();
			if (clients.length < 2) {
				this.skip();
				return;
			}
			const bob = clients[1];
			const publicClient = await hre.viem.getPublicClient();

			// Verify Bob is blocked BEFORE transfer (self-contained, no order dependency)
			await waitForNextBlock();
			await expectTxReverts(
				bob,
				{
					address: registryAddress,
					functionName: "registerVersion",
					args: [NAME_COVERED_CALL, IMPL_CC_V1],
				},
				"NotOwner",
			);

			const countBefore = (await registry.read.versionCount([NAME_COVERED_CALL])) as bigint;

			await waitForNextBlock();
			await sendWithRetry("transferOwnership", () =>
				registry.write.transferOwnership([bob.account.address], {
					gas: 5_000_000n,
				}),
			);

			const newOwner = await registry.read.owner();
			expect((newOwner as string).toLowerCase()).to.equal(bob.account.address.toLowerCase());

			// Old owner blocked
			await waitForNextBlock();
			await expectTxReverts(
				deployer,
				{
					address: registryAddress,
					functionName: "registerVersion",
					args: [NAME_COVERED_CALL, IMPL_CC_V1],
				},
				"NotOwner",
			);

			// New owner can register
			const bobRegistry = getContract({
				address: registryAddress,
				abi: registryAbi,
				client: { public: publicClient, wallet: bob },
			});
			await waitForNextBlock();
			await sendWithRetry("registerVersion (new owner)", () =>
				(bobRegistry as any).write.registerVersion([NAME_COVERED_CALL, IMPL_CC_V1], {
					gas: 5_000_000n,
				}),
			);
			const countAfter = (await registry.read.versionCount([NAME_COVERED_CALL])) as bigint;
			expect(countAfter).to.equal(countBefore + 1n);

			// latest() updated correctly after new owner's registration
			const lat = await registry.read.latest([NAME_COVERED_CALL]);
			expect((lat as string).toLowerCase()).to.equal(IMPL_CC_V1.toLowerCase());
		});
	});

	describe("Fallback", function () {
		it("reverts on unknown selector", async function () {
			const publicClient = await hre.viem.getPublicClient();
			let hash: Hex;
			try {
				hash = await deployer.sendTransaction({
					to: registryAddress,
					data: "0xdeadbeef" as Hex,
				});
			} catch (e: unknown) {
				// Only accept revert-like errors, not network/encoding errors
				const msg = (e as Error).message;
				expect(
					msg.includes("revert") ||
						msg.includes("ContractTrapped") ||
						msg.includes("unknown RPC error"),
				).to.equal(true, `expected revert error, got: ${msg.slice(0, 200)}`);
				return;
			}
			const receipt = await publicClient.waitForTransactionReceipt({
				hash,
				timeout: 30_000,
			});
			expect(receipt.status).to.equal("reverted");
		});
	});
});
