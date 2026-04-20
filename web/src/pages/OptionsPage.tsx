import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { ASSETS } from "../config/dex";
import { deployments } from "../config/deployments";
import { getPublicClient, getWalletClient, evmDevAccounts } from "../config/evm";
import { parseAbi, type Hex } from "viem";

type AssetKey = keyof typeof ASSETS;

// Only ERC20 tokens — no native (pallet-revive interop limitation)
const assetOptions: { key: AssetKey; label: string }[] = [
	{ key: "testA", label: ASSETS.testA.label },
	{ key: "testB", label: ASSETS.testB.label },
	{ key: "testC", label: ASSETS.testC.label },
	{ key: "testX", label: ASSETS.testX.label },
	{ key: "testY", label: ASSETS.testY.label },
	{ key: "testZ", label: ASSETS.testZ.label },
];

const coveredCallAbi = parseAbi([
	"function writeOption(bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 expiry) external returns (uint256)",
	"function exerciseOption(uint256 optionId) external",
	"function expireOption(uint256 optionId) external",
	"function getOption(uint256 optionId) external view returns (address seller, bytes underlying, bytes strikeAsset, uint256 amount, uint256 strikePrice, uint256 expiry, uint256 created, uint256 status)",
	"function nextOptionId() external view returns (uint256)",
]);

const erc20Abi = parseAbi([
	"function approve(address spender, uint256 amount) external returns (bool)",
]);

// ERC20 precompile addresses
const ERC20_ADDRESSES: Record<string, Hex> = {
	testA: "0x0000000100000000000000000000000001200000",
	testB: "0x0000000200000000000000000000000001200000",
	testC: "0x0000000300000000000000000000000001200000",
	testX: "0x0000000400000000000000000000000001200000",
	testY: "0x0000000500000000000000000000000001200000",
	testZ: "0x0000000600000000000000000000000001200000",
};

const STATUS_LABELS: Record<number, string> = {
	0: "Active",
	1: "Exercised",
	2: "Expired",
};

const STATUS_COLORS: Record<number, string> = {
	0: "text-green-400",
	1: "text-blue-400",
	2: "text-text-secondary",
};

type OptionData = {
	id: bigint;
	seller: string;
	underlying: AssetKey | "unknown";
	strikeAsset: AssetKey | "unknown";
	amount: bigint;
	strikePrice: bigint;
	expiry: bigint;
	created: bigint;
	status: number;
};

/** Map SCALE-encoded bytes back to an asset key */
function decodeAssetKey(hex: string): AssetKey | "unknown" {
	for (const [key, asset] of Object.entries(ASSETS)) {
		if (hex.toLowerCase() === asset.encoded.toLowerCase()) return key as AssetKey;
	}
	return "unknown";
}

function assetLabel(key: AssetKey | "unknown"): string {
	if (key === "unknown") return "???";
	return ASSETS[key].label;
}

/** Extract reason from error */
function extractReason(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	const msg =
		raw +
		(e instanceof Error && "shortMessage" in e
			? " " + (e as { shortMessage: string }).shortMessage
			: "") +
		(e instanceof Error && "details" in e ? " " + (e as { details: string }).details : "");
	const moduleMatch = msg.match(/message:\s*Some\("([^"]+)"\)/);
	if (moduleMatch) return moduleMatch[1];
	const detailsMatch = msg.match(/Details:\s*(.+?)(?:\n|Version:)/s);
	if (detailsMatch) {
		const inner = detailsMatch[1].match(/message:\s*Some\("([^"]+)"\)/);
		if (inner) return inner[1];
		return detailsMatch[1].trim().slice(0, 150);
	}
	if (e instanceof Error && "shortMessage" in e) {
		return (e as { shortMessage: string }).shortMessage.slice(0, 150);
	}
	return raw.slice(0, 150);
}

export default function OptionsPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const connected = useChainStore((s) => s.connected);

	const [accountIdx, setAccountIdx] = useState(0);
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [loading, setLoading] = useState(false);

	// Contract address — set by deploy script or manually
	const contractAddress = deployments.coveredCall ?? "";

	// Current block number + timestamp (auto-updated)
	const [currentBlock, setCurrentBlock] = useState<bigint | null>(null);
	const [blockTimestamp, setBlockTimestamp] = useState<bigint | null>(null);

	// Debug mode
	const [debug, setDebug] = useState(false);

	// Write option form
	const [underlying, setUnderlying] = useState<AssetKey>("testA");
	const [strikeAsset, setStrikeAsset] = useState<AssetKey>("testB");
	const [amount, setAmount] = useState("1000000000000");
	const [strikePrice, setStrikePrice] = useState("1");
	const [expiryMinutes, setExpiryMinutes] = useState("10");

	// Options list
	const [options, setOptions] = useState<OptionData[]>([]);

	// Exercise/expire input
	const [targetOptionId, setTargetOptionId] = useState("0");

	const account = evmDevAccounts[accountIdx].account;

	const report = (msg: string, err = false) => {
		setStatus(msg);
		setIsError(err);
		setLoading(false);
	};

	const fetchOptions = useCallback(async () => {
		if (!connected || !contractAddress) return;
		try {
			const pub_ = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Hex;
			const nextId = await pub_.readContract({
				address: addr,
				abi: coveredCallAbi,
				functionName: "nextOptionId",
			});
			const count = Number(nextId);
			const opts: OptionData[] = [];
			for (let i = 0; i < count && i < 50; i++) {
				try {
					const result = await pub_.readContract({
						address: addr,
						abi: coveredCallAbi,
						functionName: "getOption",
						args: [BigInt(i)],
					});
					const [seller, underlyingBytes, strikeBytes, amt, strike, expiry, created, stat] =
						result as [string, string, string, bigint, bigint, bigint, bigint, bigint];
					opts.push({
						id: BigInt(i),
						seller,
						underlying: decodeAssetKey(underlyingBytes),
						strikeAsset: decodeAssetKey(strikeBytes),
						amount: amt,
						strikePrice: strike,
						expiry,
						created,
						status: Number(stat),
					});
				} catch {
					// skip unreadable options
				}
			}
			setOptions(opts);
		} catch {
			// ignore
		}
	}, [connected, ethRpcUrl, contractAddress]);

	useEffect(() => {
		fetchOptions();
		const interval = setInterval(fetchOptions, 8000);
		return () => clearInterval(interval);
	}, [fetchOptions]);

	useEffect(() => {
		if (!connected) return;
		const poll = async () => {
			try {
				const pub_ = getPublicClient(ethRpcUrl);
				const block = await pub_.getBlock();
				setCurrentBlock(block.number);
				setBlockTimestamp(block.timestamp);
			} catch {
				/* ignore */
			}
		};
		poll();
		const interval = setInterval(poll, 3000);
		return () => clearInterval(interval);
	}, [connected, ethRpcUrl]);

	const doWriteOption = async () => {
		if (!connected || !contractAddress) return report("Not connected or no contract", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);
			const pub_ = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Hex;

			// Approve the contract to spend underlying tokens
			const erc20 = ERC20_ADDRESSES[underlying];
			if (erc20) {
				const approveHash = await wallet.writeContract({
					address: erc20,
					abi: erc20Abi,
					functionName: "approve",
					args: [addr as Hex, BigInt(amount)],
					gas: 5_000_000n,
				});
				await pub_.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 });
			}

			// Compute expiry from the chain's own timestamp (not browser clock)
			const latestBlock = await pub_.getBlock();
			const expiryTimestamp = latestBlock.timestamp + BigInt(Number(expiryMinutes) * 60);

			const hash = await wallet.writeContract({
				address: addr,
				abi: coveredCallAbi,
				functionName: "writeOption",
				args: [
					ASSETS[underlying].encoded,
					ASSETS[strikeAsset].encoded,
					BigInt(amount),
					BigInt(strikePrice),
					expiryTimestamp,
				],
				gas: 5_000_000n,
			});
			const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
			if (receipt.status === "reverted") {
				let reason = "unknown";
				try {
					const tx = await pub_.getTransaction({ hash });
					await pub_.call({
						to: tx.to!,
						data: tx.input,
						account: tx.from,
						gas: tx.gas,
						blockNumber: receipt.blockNumber,
					});
				} catch (replayErr) {
					reason = extractReason(replayErr);
				}
				report(`Write option reverted in block ${receipt.blockNumber}: ${reason}`, true);
			} else {
				report(`Option written in block ${receipt.blockNumber}`);
			}
			fetchOptions();
		} catch (e: unknown) {
			report(`Write option failed: ${extractReason(e)}`, true);
		}
	};

	const doExercise = async () => {
		if (!connected || !contractAddress) return report("Not connected or no contract", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);
			const pub_ = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Hex;
			const optId = BigInt(targetOptionId);

			// Find the option to know what strike asset to approve
			const opt = options.find((o) => o.id === optId);
			if (opt && opt.strikeAsset !== "unknown") {
				const erc20 = ERC20_ADDRESSES[opt.strikeAsset];
				const totalCost = opt.strikePrice * opt.amount;
				if (erc20 && totalCost > 0n) {
					const approveHash = await wallet.writeContract({
						address: erc20,
						abi: erc20Abi,
						functionName: "approve",
						args: [addr as Hex, totalCost],
						gas: 5_000_000n,
					});
					await pub_.waitForTransactionReceipt({ hash: approveHash, timeout: 30_000 });
				}
			}

			const hash = await wallet.writeContract({
				address: addr,
				abi: coveredCallAbi,
				functionName: "exerciseOption",
				args: [optId],
				gas: 5_000_000n,
			});
			const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
			if (receipt.status === "reverted") {
				let reason = "unknown";
				try {
					const tx = await pub_.getTransaction({ hash });
					await pub_.call({
						to: tx.to!,
						data: tx.input,
						account: tx.from,
						gas: tx.gas,
						blockNumber: receipt.blockNumber,
					});
				} catch (replayErr) {
					reason = extractReason(replayErr);
				}
				report(`Exercise reverted: ${reason}`, true);
			} else {
				report(`Option ${targetOptionId} exercised in block ${receipt.blockNumber}`);
			}
			fetchOptions();
		} catch (e: unknown) {
			report(`Exercise failed: ${extractReason(e)}`, true);
		}
	};

	const doExpire = async () => {
		if (!connected || !contractAddress) return report("Not connected or no contract", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);
			const pub_ = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Hex;

			const hash = await wallet.writeContract({
				address: addr,
				abi: coveredCallAbi,
				functionName: "expireOption",
				args: [BigInt(targetOptionId)],
				gas: 5_000_000n,
			});
			const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
			if (receipt.status === "reverted") {
				let reason = "unknown";
				try {
					const tx = await pub_.getTransaction({ hash });
					await pub_.call({
						to: tx.to!,
						data: tx.input,
						account: tx.from,
						gas: tx.gas,
						blockNumber: receipt.blockNumber,
					});
				} catch (replayErr) {
					reason = extractReason(replayErr);
				}
				report(`Expire reverted: ${reason}`, true);
			} else {
				report(`Option ${targetOptionId} expired in block ${receipt.blockNumber}`);
			}
			fetchOptions();
		} catch (e: unknown) {
			report(`Expire failed: ${extractReason(e)}`, true);
		}
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold font-display tracking-tight">Options</h1>
				<p className="mt-1.5 text-sm text-text-secondary leading-relaxed">
					Write and trade covered call options backed by ERC20 collateral. Uses the{" "}
					<code className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-xs font-mono">
						CoveredCall
					</code>{" "}
					PVM contract.
				</p>
			</div>

			{/* Account */}
			<div className="card">
				<label className="block text-xs font-medium text-text-secondary mb-1.5">
					Dev Account
				</label>
				<select
					className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
					value={accountIdx}
					onChange={(e) => setAccountIdx(Number(e.target.value))}
				>
					{evmDevAccounts.map((acc, i) => (
						<option key={i} value={i}>
							{acc.name}
						</option>
					))}
				</select>
				<div className="mt-2 px-1 text-xs font-mono text-text-secondary break-all">
					{account.address}
				</div>
				{currentBlock !== null && (
					<div className="mt-2 text-xs text-text-secondary">
						Block:{" "}
						<span className="font-mono text-text-primary">
							{currentBlock.toString()}
						</span>
						{debug && blockTimestamp !== null && (
							<span className="ml-2">
								| Timestamp:{" "}
								<span className="font-mono text-text-primary">
									{blockTimestamp.toString()}s
								</span>
							</span>
						)}
					</div>
				)}
				<button
					className="mt-2 text-[10px] text-text-secondary hover:text-text-primary transition-colors"
					onClick={() => setDebug((d) => !d)}
				>
					{debug ? "Hide" : "Show"} debug info
				</button>
				{!contractAddress && (
					<div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
						No CoveredCall contract deployed. Run: cd contracts/pvm-rust/e2e && npm run
						deploy:covered-call
					</div>
				)}
			</div>

			{/* Write Option */}
			<div className="card">
				<h2 className="text-lg font-semibold font-display mb-4">Write Option</h2>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Underlying (collateral)
						</label>
						<select
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
							value={underlying}
							onChange={(e) => setUnderlying(e.target.value as AssetKey)}
						>
							{assetOptions
								.filter((a) => a.key !== strikeAsset)
								.map((a) => (
									<option key={a.key} value={a.key}>
										{a.label}
									</option>
								))}
						</select>
					</div>
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Strike Asset (payment)
						</label>
						<select
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
							value={strikeAsset}
							onChange={(e) => setStrikeAsset(e.target.value as AssetKey)}
						>
							{assetOptions
								.filter((a) => a.key !== underlying)
								.map((a) => (
									<option key={a.key} value={a.key}>
										{a.label}
									</option>
								))}
						</select>
					</div>
				</div>
				<div className="grid grid-cols-3 gap-3 mt-3">
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Amount (raw units)
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
					</div>
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Strike Price (per unit)
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={strikePrice}
							onChange={(e) => setStrikePrice(e.target.value)}
						/>
					</div>
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Expires in (minutes)
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={expiryMinutes}
							onChange={(e) => setExpiryMinutes(e.target.value)}
						/>
					</div>
				</div>
				<div className="mt-4">
					<button
						className="btn-primary"
						onClick={doWriteOption}
						disabled={loading || !contractAddress}
					>
						{loading ? "Writing..." : "Write Option"}
					</button>
				</div>
			</div>

			{/* Exercise / Expire */}
			<div className="card">
				<h2 className="text-lg font-semibold font-display mb-4">Exercise / Expire</h2>
				<div className="flex gap-3 items-end">
					<div className="flex-1">
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Option ID
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={targetOptionId}
							onChange={(e) => setTargetOptionId(e.target.value)}
						/>
					</div>
					<button
						className="btn-primary"
						onClick={doExercise}
						disabled={loading || !contractAddress}
					>
						Exercise
					</button>
					<button
						className="btn-secondary"
						onClick={doExpire}
						disabled={loading || !contractAddress}
					>
						Expire
					</button>
				</div>
			</div>

			{/* Options List */}
			{options.length > 0 && (
				<div className="card">
					<h2 className="text-lg font-semibold font-display mb-4">
						Options ({options.length})
					</h2>
					<div className="space-y-2">
						{options.map((opt) => (
							<div
								key={opt.id.toString()}
								className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-3"
							>
								<div className="flex justify-between items-center mb-1">
									<span className="text-sm font-semibold">
										#{opt.id.toString()} — {assetLabel(opt.underlying)} →{" "}
										{assetLabel(opt.strikeAsset)}
									</span>
									<span
										className={`text-xs font-medium ${STATUS_COLORS[opt.status] || "text-text-secondary"}`}
									>
										{STATUS_LABELS[opt.status] || "Unknown"}
									</span>
								</div>
								<div className="text-xs font-mono text-text-secondary">
									Amount: {opt.amount.toString()} | Strike:{" "}
									{opt.strikePrice.toString()}
								</div>
								<div className="text-xs font-mono text-text-secondary">
									Created: {new Date(Number(opt.created) * 1000).toLocaleString()}
									{debug && (
										<span className="ml-1 text-yellow-400/70">
											({opt.created.toString()}s)
										</span>
									)}
									{" "}| Expires:{" "}
									{new Date(Number(opt.expiry) * 1000).toLocaleString()}
									{debug && (
										<span className="ml-1 text-yellow-400/70">
											({opt.expiry.toString()}s)
										</span>
									)}
								</div>
								<div className="text-[10px] font-mono text-text-secondary mt-1">
									Seller: {opt.seller}
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Status */}
			{status && (
				<div
					className={`rounded-lg border px-4 py-3 text-sm ${
						isError
							? "border-red-500/20 bg-red-500/[0.06] text-red-300"
							: "border-green-500/20 bg-green-500/[0.06] text-green-300"
					}`}
				>
					{status}
				</div>
			)}
		</div>
	);
}
