import { useState, useEffect, useCallback } from "react";
import { useChainStore } from "../store/chainStore";
import { assetConversionAbi, ASSET_CONVERSION_PRECOMPILE_ADDRESS, ASSETS } from "../config/dex";
import { getPublicClient, getWalletClient, evmDevAccounts } from "../config/evm";
import { parseAbi, type Hex } from "viem";

type AssetKey = keyof typeof ASSETS;

const assetOptions: { key: AssetKey; label: string }[] = [
	{ key: "native", label: ASSETS.native.label },
	{ key: "testA", label: ASSETS.testA.label },
	{ key: "testB", label: ASSETS.testB.label },
	{ key: "testC", label: ASSETS.testC.label },
	{ key: "testX", label: ASSETS.testX.label },
	{ key: "testY", label: ASSETS.testY.label },
	{ key: "testZ", label: ASSETS.testZ.label },
];

// ERC20 precompile addresses for pallet-assets tokens (InlineIdConfig<0x0120>)
const ERC20_ADDRESSES: Partial<Record<AssetKey, Hex>> = {
	testA: "0x0000000100000000000000000000000001200000",
	testB: "0x0000000200000000000000000000000001200000",
	testC: "0x0000000300000000000000000000000001200000",
	testX: "0x0000000400000000000000000000000001200000",
	testY: "0x0000000500000000000000000000000001200000",
	testZ: "0x0000000600000000000000000000000001200000",
};

const erc20BalanceAbi = parseAbi([
	"function balanceOf(address account) external view returns (uint256)",
]);

// LP token ERC20 precompile addresses (Instance2, prefix 0x0220).
// Address layout: [id_be32][zeros(12)][0x02,0x20][zeros(2)]
function lpTokenAddress(id: number): Hex {
	const idHex = id.toString(16).padStart(8, "0");
	return `0x${idHex}00000000000000000000000002200000` as Hex;
}
// LP tokens are auto-incremented in PoolAssets (Instance2).
// Check IDs 0-9 to cover pools created on a fresh chain.
const LP_TOKEN_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const ETH_RATIO = 1_000_000n;

/** For native token amounts (inflated by NativeToEthRatio=1e6 in eth-rpc),
 *  show what the raw value means on-chain. Returns null for non-native assets. */
function nativeHint(amount: string, asset: AssetKey): string | null {
	if (asset !== "native") return null;
	try {
		const big = BigInt(amount);
		if (big === 0n) return null;
		const onChain = big / ETH_RATIO;
		const dust = big % ETH_RATIO;
		return dust > 0n
			? `${onChain} on-chain units (+${dust} sub-unit dust)`
			: `${onChain} on-chain units`;
	} catch {
		return null;
	}
}

type TxRecord = {
	action: string;
	blockNumber: bigint;
	txHash: string;
	status: string;
	timestamp: number;
};

function StatusMessage({ message, isError }: { message: string; isError?: boolean }) {
	if (!message) return null;
	return (
		<div
			className={`mt-3 rounded-lg border px-4 py-3 text-sm ${
				isError
					? "border-red-500/20 bg-red-500/[0.06] text-red-300"
					: "border-green-500/20 bg-green-500/[0.06] text-green-300"
			}`}
		>
			{message}
		</div>
	);
}

function TxHistory({ records }: { records: TxRecord[] }) {
	if (records.length === 0) return null;
	return (
		<div className="card mt-6">
			<h2 className="text-lg font-semibold font-display mb-3">Transaction History</h2>
			<div className="space-y-2">
				{records.map((r, i) => (
					<div
						key={i}
						className={`rounded-lg border px-4 py-3 text-xs font-mono ${
							r.status === "success"
								? "border-green-500/20 bg-green-500/[0.06] text-green-300"
								: "border-red-500/20 bg-red-500/[0.06] text-red-300"
						}`}
					>
						<div className="flex justify-between items-center mb-1">
							<span className="font-semibold font-sans text-sm">{r.action}</span>
							<span className="text-text-secondary">
								{r.status === "success" ? "confirmed" : "reverted"}
							</span>
						</div>
						<div className="text-text-secondary">
							Block:{" "}
							<span className="text-text-primary">{r.blockNumber.toString()}</span>
							{" | "}
							Tx: <span className="text-text-primary">{r.txHash}</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export default function DexPage() {
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const connected = useChainStore((s) => s.connected);

	const [accountIdx, setAccountIdx] = useState(0);
	const [status, setStatus] = useState("");
	const [isError, setIsError] = useState(false);
	const [loading, setLoading] = useState(false);
	const [txHistory, setTxHistory] = useState<TxRecord[]>([]);

	// Balances
	const [balances, setBalances] = useState<Record<AssetKey, string>>({
		native: "-",
		testA: "-",
		testB: "-",
		testC: "-",
		testX: "-",
		testY: "-",
		testZ: "-",
	});

	// Swap state — path supports multi-hop (e.g. native → testA → testB)
	const [swapPath, setSwapPath] = useState<AssetKey[]>(["native", "testA"]);
	const [swapAmount, setSwapAmount] = useState("1000000000000");
	const [quoteResult, setQuoteResult] = useState("");

	const swapFrom = swapPath[0];
	const swapTo = swapPath[swapPath.length - 1];

	const updateSwapPath = (index: number, value: AssetKey) => {
		setSwapPath((prev) => {
			const next = [...prev];
			next[index] = value;
			return next;
		});
	};

	const addSwapHop = () => {
		if (swapPath.length >= 4) return; // MaxSwapPathLength = 4
		// Pick the first asset not already at the end
		const last = swapPath[swapPath.length - 1];
		const candidate = assetOptions.find((a) => a.key !== last);
		if (candidate) setSwapPath((prev) => [...prev, candidate.key]);
	};

	const removeSwapHop = () => {
		if (swapPath.length <= 2) return;
		setSwapPath((prev) => prev.slice(0, -1));
	};

	// Pool state
	const [poolAsset1, setPoolAsset1] = useState<AssetKey>("native");
	const [poolAsset2, setPoolAsset2] = useState<AssetKey>("testA");
	const [poolAmount1, setPoolAmount1] = useState("1000000000000");
	const [poolAmount2, setPoolAmount2] = useState("1000000000000");

	// Remove liquidity state
	const [removeLpAmount, setRemoveLpAmount] = useState("1000000000000");

	// Pool info
	const [poolReserves, setPoolReserves] = useState<{
		reserve1: bigint;
		reserve2: bigint;
		rate1to2: string;
		rate2to1: string;
	} | null>(null);
	const [lpBalance, setLpBalance] = useState<string | null>(null);

	const account = evmDevAccounts[accountIdx].account;

	const report = (msg: string, err = false) => {
		setStatus(msg);
		setIsError(err);
		setLoading(false);
	};

	const addTx = (action: string, blockNumber: bigint, txHash: string, status: string) => {
		setTxHistory((prev) => [
			{ action, blockNumber, txHash, status, timestamp: Date.now() },
			...prev,
		]);
	};

	/** Extract a human-readable reason from an error message. */
	const extractReason = (e: unknown): string => {
		const raw = e instanceof Error ? e.message : String(e);
		// Also check .cause and .details (viem nests errors deeply)
		const msg =
			raw +
			(e instanceof Error && "shortMessage" in e
				? " " + (e as { shortMessage: string }).shortMessage
				: "") +
			(e instanceof Error && "details" in e ? " " + (e as { details: string }).details : "");
		// eth-rpc surfaces pallet errors as 'message: Some("PoolExists")'
		const moduleMatch = msg.match(/message:\s*Some\("([^"]+)"\)/);
		if (moduleMatch) return moduleMatch[1];
		// Also matches: "failed to run contract: Module(ModuleError { ... message: Some("X") })"
		const detailsMatch = msg.match(/Details:\s*(.+?)(?:\n|Version:)/s);
		if (detailsMatch) {
			const details = detailsMatch[1].trim();
			const innerModule = details.match(/message:\s*Some\("([^"]+)"\)/);
			if (innerModule) return innerModule[1];
			return details.slice(0, 150);
		}
		// Solidity-style revert reason
		const revertMatch = msg.match(/reverted with reason string '([^']+)'/);
		if (revertMatch) return revertMatch[1];
		// Fallback: viem shortMessage is usually the most useful
		if (e instanceof Error && "shortMessage" in e) {
			return (e as { shortMessage: string }).shortMessage.slice(0, 150);
		}
		return raw.slice(0, 150);
	};

	/** Send a write tx, check receipt status, report + log result.
	 *  If the receipt shows revert, replays the tx as eth_call to extract the reason. */
	const sendAndReport = async (action: string, sendFn: () => Promise<Hex>) => {
		const pub_ = getPublicClient(ethRpcUrl);
		const hash = await sendFn();
		const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
		addTx(action, receipt.blockNumber, hash, receipt.status);
		if (receipt.status === "reverted") {
			// Try to get the revert reason by replaying the tx as eth_call
			let reason = "unknown reason";
			try {
				const tx = await pub_.getTransaction({ hash });
				await pub_.call({
					to: tx.to!,
					data: tx.input,
					account: tx.from,
					gas: tx.gas,
					blockNumber: receipt.blockNumber,
				});
			} catch (replayErr: unknown) {
				reason = extractReason(replayErr);
			}
			report(`${action} reverted in block ${receipt.blockNumber}: ${reason}`, true);
			return null;
		}
		report(`${action} confirmed in block ${receipt.blockNumber}`);
		return receipt;
	};

	const fetchBalances = useCallback(async () => {
		if (!connected) return;
		try {
			const pub_ = getPublicClient(ethRpcUrl);
			const addr = account.address;

			// Native balance
			const native = await pub_.getBalance({ address: addr });
			const newBalances: Record<AssetKey, string> = {
				native: native.toString(),
				testA: "-",
				testB: "-",
				testC: "-",
				testX: "-",
				testY: "-",
				testZ: "-",
			};

			// ERC20 balances
			for (const key of ["testA", "testB", "testC", "testX", "testY", "testZ"] as const) {
				const erc20 = ERC20_ADDRESSES[key];
				if (!erc20) continue;
				try {
					const bal = await pub_.readContract({
						address: erc20,
						abi: erc20BalanceAbi,
						functionName: "balanceOf",
						args: [addr],
					});
					newBalances[key] = bal.toString();
				} catch {
					newBalances[key] = "0";
				}
			}
			setBalances(newBalances);
		} catch {
			// silently ignore balance fetch errors
		}
	}, [connected, ethRpcUrl, account.address]);

	useEffect(() => {
		fetchBalances();
		const interval = setInterval(fetchBalances, 6000);
		return () => clearInterval(interval);
	}, [fetchBalances]);

	const fetchPoolInfo = useCallback(async () => {
		if (!connected) return;
		const pub_ = getPublicClient(ethRpcUrl);
		const probeAmount = 1_000_000_000_000n; // 1e12
		try {
			const [fwd, rev, reserves] = await Promise.all([
				pub_
					.readContract({
						address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
						abi: assetConversionAbi,
						functionName: "quoteExactTokensForTokens",
						args: [
							ASSETS[poolAsset1].encoded,
							ASSETS[poolAsset2].encoded,
							probeAmount,
							true,
						],
					})
					.catch(() => null),
				pub_
					.readContract({
						address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
						abi: assetConversionAbi,
						functionName: "quoteExactTokensForTokens",
						args: [
							ASSETS[poolAsset2].encoded,
							ASSETS[poolAsset1].encoded,
							probeAmount,
							true,
						],
					})
					.catch(() => null),
				pub_
					.readContract({
						address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
						abi: assetConversionAbi,
						functionName: "getReserves",
						args: [ASSETS[poolAsset1].encoded, ASSETS[poolAsset2].encoded],
					})
					.catch(() => null),
			]);
			if (fwd !== null && rev !== null && reserves !== null) {
				const [reserve1, reserve2] = reserves as [bigint, bigint];
				setPoolReserves({
					reserve1,
					reserve2,
					rate1to2: `${probeAmount} ${ASSETS[poolAsset1].label} = ${fwd} ${ASSETS[poolAsset2].label}`,
					rate2to1: `${probeAmount} ${ASSETS[poolAsset2].label} = ${rev} ${ASSETS[poolAsset1].label}`,
				});
			} else {
				setPoolReserves(null);
			}

			// Query LP token balances across all possible pool LP tokens
			let totalLp = 0n;
			for (const id of LP_TOKEN_IDS) {
				try {
					const bal = await pub_.readContract({
						address: lpTokenAddress(id),
						abi: erc20BalanceAbi,
						functionName: "balanceOf",
						args: [account.address],
					});
					totalLp += bal;
				} catch {
					// LP token doesn't exist or no balance
				}
			}
			setLpBalance(totalLp > 0n ? totalLp.toString() : null);
		} catch {
			setPoolReserves(null);
			setLpBalance(null);
		}
	}, [connected, ethRpcUrl, poolAsset1, poolAsset2, account.address]);

	useEffect(() => {
		fetchPoolInfo();
		const interval = setInterval(fetchPoolInfo, 6000);
		return () => clearInterval(interval);
	}, [fetchPoolInfo]);

	const getQuote = async () => {
		if (!connected) return report("Not connected", true);
		setLoading(true);
		try {
			const pub_ = getPublicClient(ethRpcUrl);
			// Chain quotes hop-by-hop for multi-hop paths
			let currentAmount = BigInt(swapAmount);
			for (let i = 0; i < swapPath.length - 1; i++) {
				currentAmount = await pub_.readContract({
					address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
					abi: assetConversionAbi,
					functionName: "quoteExactTokensForTokens",
					args: [
						ASSETS[swapPath[i]].encoded,
						ASSETS[swapPath[i + 1]].encoded,
						currentAmount,
						true,
					],
				});
			}
			setQuoteResult(currentAmount.toString());
			const route = swapPath.map((k) => ASSETS[k].label).join(" → ");
			report(`Quote: ${swapAmount} ${route} => ${currentAmount.toString()}`);
		} catch (e: unknown) {
			report(`Quote failed: ${extractReason(e)}`, true);
		}
	};

	const doSwap = async () => {
		if (!connected) return report("Not connected", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);
			const path = swapPath.map((k) => ASSETS[k].encoded);

			const receipt = await sendAndReport("Swap", () =>
				wallet.writeContract({
					address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
					abi: assetConversionAbi,
					functionName: "swapExactTokensForTokens",
					args: [path, BigInt(swapAmount), 1n, account.address, false],
					gas: 5_000_000n,
				}),
			);
			if (receipt) {
				fetchBalances();
				fetchPoolInfo();
			}
		} catch (e: unknown) {
			report(`Swap failed: ${extractReason(e)}`, true);
		}
	};

	const createPool = async () => {
		if (!connected) return report("Not connected", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);

			await sendAndReport("Create Pool", () =>
				wallet.writeContract({
					address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
					abi: assetConversionAbi,
					functionName: "createPool",
					args: [ASSETS[poolAsset1].encoded, ASSETS[poolAsset2].encoded],
					gas: 5_000_000n,
				}),
			);
		} catch (e: unknown) {
			report(`Create pool failed: ${extractReason(e)}`, true);
		}
	};

	const addLiquidity = async () => {
		if (!connected) return report("Not connected", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);

			const receipt = await sendAndReport("Add Liquidity", () =>
				wallet.writeContract({
					address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
					abi: assetConversionAbi,
					functionName: "addLiquidity",
					args: [
						ASSETS[poolAsset1].encoded,
						ASSETS[poolAsset2].encoded,
						BigInt(poolAmount1),
						BigInt(poolAmount2),
						0n,
						0n,
						account.address,
					],
					gas: 5_000_000n,
				}),
			);
			if (receipt) {
				fetchBalances();
				fetchPoolInfo();
			}
		} catch (e: unknown) {
			report(`Add liquidity failed: ${extractReason(e)}`, true);
		}
	};

	const removeLiquidity = async () => {
		if (!connected) return report("Not connected", true);
		setLoading(true);
		try {
			const wallet = await getWalletClient(accountIdx, ethRpcUrl);

			const receipt = await sendAndReport("Remove Liquidity", () =>
				wallet.writeContract({
					address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
					abi: assetConversionAbi,
					functionName: "removeLiquidity",
					args: [
						ASSETS[poolAsset1].encoded,
						ASSETS[poolAsset2].encoded,
						BigInt(removeLpAmount),
						0n,
						0n,
						account.address,
					],
					gas: 5_000_000n,
				}),
			);
			if (receipt) {
				fetchBalances();
				fetchPoolInfo();
			}
		} catch (e: unknown) {
			report(`Remove liquidity failed: ${extractReason(e)}`, true);
		}
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-bold font-display tracking-tight">DEX</h1>
				<p className="mt-1.5 text-sm text-text-secondary leading-relaxed">
					Swap tokens and manage liquidity pools via the{" "}
					<code className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-xs font-mono">
						asset-conversion
					</code>{" "}
					precompile.
				</p>
			</div>

			{/* Account selector + balances */}
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

				<div className="mt-3 grid grid-cols-3 gap-2">
					{assetOptions.map((a) => {
						const raw = balances[a.key];
						if (raw === "-") {
							return (
								<div
									key={a.key}
									className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2"
								>
									<div className="text-xs text-text-secondary">{a.label}</div>
									<div className="text-sm font-mono mt-0.5">-</div>
								</div>
							);
						}
						const total = BigInt(raw);
						const ed = ASSETS[a.key].ed * (a.key === "native" ? ETH_RATIO : 1n);
						const free = total > ed ? total - ed : 0n;
						return (
							<div
								key={a.key}
								className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2"
							>
								<div className="text-xs text-text-secondary">{a.label}</div>
								<div className="text-sm font-mono mt-0.5 truncate">
									{free.toString()}
								</div>
								<div className="text-[10px] font-mono text-text-secondary truncate">
									{ed > 0n && `${ed.toString()} locked (ED)`}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* Swap section */}
			<div className="card">
				<h2 className="text-lg font-semibold font-display mb-4">Swap</h2>
				<div className="space-y-2">
					{swapPath.map((asset, i) => (
						<div key={i} className="flex items-center gap-2">
							<label className="text-xs font-medium text-text-secondary w-12 shrink-0">
								{i === 0 ? "From" : i === swapPath.length - 1 ? "To" : `Via`}
							</label>
							<select
								className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
								value={asset}
								onChange={(e) => updateSwapPath(i, e.target.value as AssetKey)}
							>
								{assetOptions
									.filter((a) => {
										const prev = i > 0 ? swapPath[i - 1] : null;
										const next =
											i < swapPath.length - 1 ? swapPath[i + 1] : null;
										return a.key !== prev && a.key !== next;
									})
									.map((a) => (
										<option key={a.key} value={a.key}>
											{a.label}
										</option>
									))}
							</select>
							{i < swapPath.length - 1 && (
								<span className="text-text-secondary text-xs">→</span>
							)}
						</div>
					))}
					<div className="flex gap-2">
						<button
							className="text-xs text-text-secondary hover:text-text-primary"
							onClick={() => setSwapPath((prev) => [...prev].reverse())}
							title="Flip direction"
						>
							&#x21C5; Flip
						</button>
						<button
							className="text-xs text-text-secondary hover:text-text-primary"
							onClick={addSwapHop}
							disabled={swapPath.length >= 4}
						>
							+ Add hop
						</button>
						{swapPath.length > 2 && (
							<button
								className="text-xs text-text-secondary hover:text-text-primary"
								onClick={removeSwapHop}
							>
								- Remove hop
							</button>
						)}
					</div>
				</div>
				<div className="mt-3">
					<label className="block text-xs font-medium text-text-secondary mb-1">
						Amount (raw units)
					</label>
					<input
						type="text"
						className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
						value={swapAmount}
						onChange={(e) => setSwapAmount(e.target.value)}
					/>
					{nativeHint(swapAmount, swapFrom) && (
						<div className="mt-1 text-[10px] font-mono text-text-secondary">
							{nativeHint(swapAmount, swapFrom)}
						</div>
					)}
				</div>
				{quoteResult && (
					<div className="mt-2 text-sm text-text-secondary font-mono">
						Expected output: {quoteResult}
						{nativeHint(quoteResult, swapTo) && (
							<span className="text-[10px] ml-2">
								{nativeHint(quoteResult, swapTo)}
							</span>
						)}
					</div>
				)}
				<div className="mt-4 flex gap-3">
					<button className="btn-secondary" onClick={getQuote} disabled={loading}>
						Get Quote
					</button>
					<button className="btn-primary" onClick={doSwap} disabled={loading}>
						{loading ? "Swapping..." : "Swap"}
					</button>
				</div>
			</div>

			{/* Pool section */}
			<div className="card">
				<h2 className="text-lg font-semibold font-display mb-4">Pool Management</h2>

				{poolReserves ? (
					(() => {
						const total = poolReserves.reserve1 + poolReserves.reserve2;
						const pct1 =
							total > 0n
								? Number((poolReserves.reserve1 * 10000n) / total) / 100
								: 50;
						const pct2 =
							total > 0n
								? Number((poolReserves.reserve2 * 10000n) / total) / 100
								: 50;
						return (
							<div className="mb-4 rounded-lg border border-blue-500/20 bg-blue-500/[0.06] px-4 py-3 text-sm">
								<div className="text-xs font-medium text-text-secondary mb-2">
									Pool Reserves
								</div>
								{/* Reserve numbers */}
								<div className="flex justify-between mb-2">
									<div>
										<span className="text-xs text-text-secondary">
											{ASSETS[poolAsset1].label}
										</span>
										<div className="font-mono text-sm text-emerald-400">
											{poolReserves.reserve1.toLocaleString()}
										</div>
									</div>
									<div className="text-right">
										<span className="text-xs text-text-secondary">
											{ASSETS[poolAsset2].label}
										</span>
										<div className="font-mono text-sm text-rose-400">
											{poolReserves.reserve2.toLocaleString()}
										</div>
									</div>
								</div>
								{/* Proportion bar */}
								<div className="flex h-3 rounded-full overflow-hidden border border-white/[0.08]">
									<div
										className="bg-emerald-500 transition-all duration-500"
										style={{ width: `${pct1}%` }}
										title={`${ASSETS[poolAsset1].label}: ${pct1.toFixed(1)}%`}
									/>
									<div
										className="bg-rose-500 transition-all duration-500"
										style={{ width: `${pct2}%` }}
										title={`${ASSETS[poolAsset2].label}: ${pct2.toFixed(1)}%`}
									/>
								</div>
								<div className="flex justify-between mt-1">
									<span className="text-[10px] font-mono text-emerald-400/70">
										{pct1.toFixed(1)}%
									</span>
									<span className="text-[10px] font-mono text-rose-400/70">
										{pct2.toFixed(1)}%
									</span>
								</div>
								{/* Rates */}
								<div className="mt-2 pt-2 border-t border-white/[0.06]">
									<div className="font-mono text-xs text-text-secondary">
										{poolReserves.rate1to2}
									</div>
									<div className="font-mono text-xs text-text-secondary">
										{poolReserves.rate2to1}
									</div>
								</div>
							</div>
						);
					})()
				) : (
					<div className="mb-4 rounded-lg border border-white/[0.08] bg-white/[0.04] px-4 py-3 text-xs text-text-secondary">
						No pool found for selected pair
					</div>
				)}

				<div className="flex items-end gap-2">
					<div className="flex-1">
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Asset 1
						</label>
						<select
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
							value={poolAsset1}
							onChange={(e) => setPoolAsset1(e.target.value as AssetKey)}
						>
							{assetOptions
								.filter((a) => a.key !== poolAsset2)
								.map((a) => (
									<option key={a.key} value={a.key}>
										{a.label}
									</option>
								))}
						</select>
					</div>
					<button
						className="shrink-0 mb-0.5 px-2 py-2 rounded-lg border border-white/[0.08] bg-white/[0.04] text-sm text-text-secondary hover:text-text-primary"
						onClick={() => {
							setPoolAsset1(poolAsset2);
							setPoolAsset2(poolAsset1);
							setPoolAmount1(poolAmount2);
							setPoolAmount2(poolAmount1);
						}}
						title="Flip assets"
					>
						&#x21C5;
					</button>
					<div className="flex-1">
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Asset 2
						</label>
						<select
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
							value={poolAsset2}
							onChange={(e) => setPoolAsset2(e.target.value as AssetKey)}
						>
							{assetOptions
								.filter((a) => a.key !== poolAsset1)
								.map((a) => (
									<option key={a.key} value={a.key}>
										{a.label}
									</option>
								))}
						</select>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-3 mt-3">
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Amount 1
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={poolAmount1}
							onChange={(e) => setPoolAmount1(e.target.value)}
						/>
						{nativeHint(poolAmount1, poolAsset1) && (
							<div className="mt-1 text-[10px] font-mono text-text-secondary">
								{nativeHint(poolAmount1, poolAsset1)}
							</div>
						)}
					</div>
					<div>
						<label className="block text-xs font-medium text-text-secondary mb-1">
							Amount 2
						</label>
						<input
							type="text"
							className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
							value={poolAmount2}
							onChange={(e) => setPoolAmount2(e.target.value)}
						/>
						{nativeHint(poolAmount2, poolAsset2) && (
							<div className="mt-1 text-[10px] font-mono text-text-secondary">
								{nativeHint(poolAmount2, poolAsset2)}
							</div>
						)}
					</div>
				</div>
				<div className="mt-4 flex gap-3">
					<button
						className="btn-secondary"
						onClick={createPool}
						disabled={loading || !!poolReserves}
					>
						{poolReserves ? "Pool Exists" : "Create Pool"}
					</button>
					<button className="btn-primary" onClick={addLiquidity} disabled={loading}>
						{loading ? "Adding..." : "Add Liquidity"}
					</button>
				</div>

				<hr className="border-white/[0.06] my-4" />

				<h3 className="text-sm font-semibold font-display mb-3">Remove Liquidity</h3>
				{lpBalance && (
					<div className="mb-3 text-xs text-text-secondary">
						Your LP tokens:{" "}
						<span className="font-mono text-text-primary">{lpBalance}</span>
					</div>
				)}
				<div>
					<label className="block text-xs font-medium text-text-secondary mb-1">
						LP Tokens to Burn
					</label>
					<input
						type="text"
						className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
						value={removeLpAmount}
						onChange={(e) => setRemoveLpAmount(e.target.value)}
					/>
				</div>
				<div className="mt-3">
					<button className="btn-primary" onClick={removeLiquidity} disabled={loading}>
						{loading ? "Removing..." : "Remove Liquidity"}
					</button>
				</div>
			</div>

			<StatusMessage message={status} isError={isError} />

			<TxHistory records={txHistory} />
		</div>
	);
}
