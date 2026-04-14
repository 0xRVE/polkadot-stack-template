import { useState } from "react";
import { useChainStore } from "../store/chainStore";
import {
  assetConversionAbi,
  ASSET_CONVERSION_PRECOMPILE_ADDRESS,
  ASSETS,
} from "../config/dex";
import { getPublicClient, getWalletClient, evmDevAccounts } from "../config/evm";

type AssetKey = keyof typeof ASSETS;

const assetOptions: { key: AssetKey; label: string }[] = [
  { key: "native", label: ASSETS.native.label },
  { key: "testA", label: ASSETS.testA.label },
  { key: "testB", label: ASSETS.testB.label },
];

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

export default function DexPage() {
  const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
  const connected = useChainStore((s) => s.connected);

  const [accountIdx, setAccountIdx] = useState(0);
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);

  // Swap state
  const [swapFrom, setSwapFrom] = useState<AssetKey>("native");
  const [swapTo, setSwapTo] = useState<AssetKey>("testA");
  const [swapAmount, setSwapAmount] = useState("1000000000000");
  const [quoteResult, setQuoteResult] = useState("");

  // Pool state
  const [poolAsset1, setPoolAsset1] = useState<AssetKey>("native");
  const [poolAsset2, setPoolAsset2] = useState<AssetKey>("testA");
  const [poolAmount1, setPoolAmount1] = useState("1000000000000");
  const [poolAmount2, setPoolAmount2] = useState("1000000000000");

  const report = (msg: string, err = false) => {
    setStatus(msg);
    setIsError(err);
    setLoading(false);
  };

  const getQuote = async () => {
    if (!connected) return report("Not connected", true);
    setLoading(true);
    try {
      const pub_ = getPublicClient(ethRpcUrl);
      const result = await pub_.readContract({
        address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
        abi: assetConversionAbi,
        functionName: "quoteExactTokensForTokens",
        args: [
          ASSETS[swapFrom].encoded,
          ASSETS[swapTo].encoded,
          BigInt(swapAmount),
          true,
        ],
      });
      setQuoteResult(result.toString());
      report(`Quote: ${swapAmount} ${ASSETS[swapFrom].label} => ${result.toString()} ${ASSETS[swapTo].label}`);
    } catch (e: any) {
      report(`Quote failed: ${e.message?.slice(0, 120)}`, true);
    }
  };

  const doSwap = async () => {
    if (!connected) return report("Not connected", true);
    setLoading(true);
    try {
      const wallet = await getWalletClient(accountIdx, ethRpcUrl);
      const pub_ = getPublicClient(ethRpcUrl);
      const account = evmDevAccounts[accountIdx].account;
      const path = [ASSETS[swapFrom].encoded, ASSETS[swapTo].encoded];

      const hash = await wallet.writeContract({
        address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
        abi: assetConversionAbi,
        functionName: "swapExactTokensForTokens",
        args: [path, BigInt(swapAmount), 0n, account.address, false],
      });
      const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
      report(`Swap confirmed in block ${receipt.blockNumber}`);
    } catch (e: any) {
      report(`Swap failed: ${e.message?.slice(0, 120)}`, true);
    }
  };

  const createPool = async () => {
    if (!connected) return report("Not connected", true);
    setLoading(true);
    try {
      const wallet = await getWalletClient(accountIdx, ethRpcUrl);
      const pub_ = getPublicClient(ethRpcUrl);

      const hash = await wallet.writeContract({
        address: ASSET_CONVERSION_PRECOMPILE_ADDRESS,
        abi: assetConversionAbi,
        functionName: "createPool",
        args: [ASSETS[poolAsset1].encoded, ASSETS[poolAsset2].encoded],
      });
      const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
      report(`Pool created in block ${receipt.blockNumber}`);
    } catch (e: any) {
      report(`Create pool failed: ${e.message?.slice(0, 120)}`, true);
    }
  };

  const addLiquidity = async () => {
    if (!connected) return report("Not connected", true);
    setLoading(true);
    try {
      const wallet = await getWalletClient(accountIdx, ethRpcUrl);
      const pub_ = getPublicClient(ethRpcUrl);
      const account = evmDevAccounts[accountIdx].account;

      const hash = await wallet.writeContract({
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
      });
      const receipt = await pub_.waitForTransactionReceipt({ hash, timeout: 60_000 });
      report(`Liquidity added in block ${receipt.blockNumber}`);
    } catch (e: any) {
      report(`Add liquidity failed: ${e.message?.slice(0, 120)}`, true);
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

      {/* Account selector */}
      <div className="card">
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Dev Account</label>
        <select
          className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
          value={accountIdx}
          onChange={(e) => setAccountIdx(Number(e.target.value))}
        >
          {evmDevAccounts.map((acc, i) => (
            <option key={i} value={i}>
              {acc.name} ({acc.account.address.slice(0, 10)}...)
            </option>
          ))}
        </select>
      </div>

      {/* Swap section */}
      <div className="card">
        <h2 className="text-lg font-semibold font-display mb-4">Swap</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">From</label>
            <select
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
              value={swapFrom}
              onChange={(e) => setSwapFrom(e.target.value as AssetKey)}
            >
              {assetOptions.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">To</label>
            <select
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
              value={swapTo}
              onChange={(e) => setSwapTo(e.target.value as AssetKey)}
            >
              {assetOptions.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-xs font-medium text-text-secondary mb-1">Amount (raw units)</label>
          <input
            type="text"
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
            value={swapAmount}
            onChange={(e) => setSwapAmount(e.target.value)}
          />
        </div>
        {quoteResult && (
          <div className="mt-2 text-sm text-text-secondary font-mono">
            Expected output: {quoteResult}
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Asset 1</label>
            <select
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
              value={poolAsset1}
              onChange={(e) => setPoolAsset1(e.target.value as AssetKey)}
            >
              {assetOptions.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Asset 2</label>
            <select
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm"
              value={poolAsset2}
              onChange={(e) => setPoolAsset2(e.target.value as AssetKey)}
            >
              {assetOptions.map((a) => (
                <option key={a.key} value={a.key}>{a.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Amount 1</label>
            <input
              type="text"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
              value={poolAmount1}
              onChange={(e) => setPoolAmount1(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">Amount 2</label>
            <input
              type="text"
              className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm font-mono"
              value={poolAmount2}
              onChange={(e) => setPoolAmount2(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4 flex gap-3">
          <button className="btn-secondary" onClick={createPool} disabled={loading}>
            Create Pool
          </button>
          <button className="btn-primary" onClick={addLiquidity} disabled={loading}>
            {loading ? "Adding..." : "Add Liquidity"}
          </button>
        </div>
      </div>

      <StatusMessage message={status} isError={isError} />
    </div>
  );
}
