import { useState, type ReactNode } from "react";
import { type Address } from "viem";
import {
  counterAbi,
  evmDevAccounts,
  getPublicClient,
  getWalletClient,
} from "../config/evm";

interface Props {
  title: string;
  description: ReactNode;
  accentColor: "purple" | "green";
  storageKey: string;
}

const colorMap = {
  purple: {
    title: "text-purple-400",
    button: "bg-purple-600 hover:bg-purple-700",
  },
  green: {
    title: "text-green-400",
    button: "bg-green-600 hover:bg-green-700",
  },
};

export default function ContractCounterPage({
  title,
  description,
  accentColor,
  storageKey,
}: Props) {
  const colors = colorMap[accentColor];
  const [contractAddress, setContractAddress] = useState(
    () => localStorage.getItem(storageKey) || ""
  );
  const [selectedAccount, setSelectedAccount] = useState(0);
  const [counterValue, setCounterValue] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [txStatus, setTxStatus] = useState<string | null>(null);

  function saveAddress(address: string) {
    setContractAddress(address);
    localStorage.setItem(storageKey, address);
  }

  async function queryCounter() {
    if (!contractAddress) {
      setTxStatus("Error: Enter a contract address first");
      return;
    }
    try {
      setTxStatus(null);
      const client = getPublicClient();
      const account = evmDevAccounts[selectedAccount].account;
      const value = await client.readContract({
        address: contractAddress as Address,
        abi: counterAbi,
        functionName: "getCounter",
        args: [account.address],
      });
      setCounterValue(value.toString());
    } catch (e) {
      console.error("Failed to query counter:", e);
      setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function setCounter() {
    if (!contractAddress) {
      setTxStatus("Error: Enter a contract address first");
      return;
    }
    try {
      setTxStatus("Submitting setCounter...");
      const walletClient = await getWalletClient(selectedAccount);
      const hash = await walletClient.writeContract({
        address: contractAddress as Address,
        abi: counterAbi,
        functionName: "setCounter",
        args: [BigInt(inputValue || "0")],
      });
      setTxStatus(`Transaction submitted: ${hash}`);
      const publicClient = getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });
      setTxStatus("setCounter confirmed!");
      queryCounter();
    } catch (e) {
      console.error("Transaction failed:", e);
      setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function increment() {
    if (!contractAddress) {
      setTxStatus("Error: Enter a contract address first");
      return;
    }
    try {
      setTxStatus("Submitting increment...");
      const walletClient = await getWalletClient(selectedAccount);
      const hash = await walletClient.writeContract({
        address: contractAddress as Address,
        abi: counterAbi,
        functionName: "increment",
      });
      setTxStatus(`Transaction submitted: ${hash}`);
      const publicClient = getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });
      setTxStatus("increment confirmed!");
      queryCounter();
    } catch (e) {
      console.error("Transaction failed:", e);
      setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className={`text-2xl font-bold ${colors.title}`}>{title}</h1>
      <p className="text-gray-400">{description}</p>

      <div className="bg-gray-900 rounded-lg p-5 border border-gray-800 space-y-4">
        <div>
          <label className="text-sm text-gray-400 block mb-1">
            Contract Address
          </label>
          <input
            type="text"
            value={contractAddress}
            onChange={(e) => saveAddress(e.target.value)}
            placeholder="0x..."
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white w-full font-mono text-sm"
          />
        </div>

        <div>
          <label className="text-sm text-gray-400 block mb-1">
            Dev Account
          </label>
          <select
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(parseInt(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white w-full"
          >
            {evmDevAccounts.map((acc, i) => (
              <option key={i} value={i}>
                {acc.name} ({acc.account.address})
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-3">
          <button
            onClick={queryCounter}
            className={`px-4 py-2 ${colors.button} rounded text-white text-sm`}
          >
            Query Counter
          </button>
          <span className="text-lg font-mono self-center">
            Value: {counterValue !== null ? counterValue : "—"}
          </span>
        </div>

        <div className="flex gap-3">
          <input
            type="number"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="Enter value"
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white flex-1"
          />
          <button
            onClick={setCounter}
            className={`px-4 py-2 ${colors.button} rounded text-white text-sm`}
          >
            Set Counter
          </button>
        </div>

        <button
          onClick={increment}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded text-white text-sm"
        >
          Increment
        </button>

        {txStatus && (
          <p
            className={`text-sm ${txStatus.startsWith("Error") ? "text-red-400" : "text-green-400"}`}
          >
            {txStatus}
          </p>
        )}
      </div>
    </div>
  );
}
