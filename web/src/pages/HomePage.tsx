import { useEffect, useState, useCallback, useRef } from "react";
import { getClient, disconnectClient } from "../hooks/useChain";
import { useChainStore } from "../store/chainStore";
import { stack_template } from "@polkadot-api/descriptors";

export default function HomePage() {
  const {
    wsUrl,
    setWsUrl,
    connected,
    blockNumber,
    setConnected,
    setBlockNumber,
    pallets,
    setPallets,
  } = useChainStore();
  const [chainName, setChainName] = useState<string>("...");
  const [error, setError] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState(wsUrl);
  const [connecting, setConnecting] = useState(false);
  const connectIdRef = useRef(0);

  const connect = useCallback(
    async (url: string) => {
      const id = ++connectIdRef.current;
      setConnecting(true);
      setError(null);
      setConnected(false);
      setChainName("...");
      setPallets({ templatePallet: null, revive: null });

      disconnectClient();

      try {
        const client = getClient(url);
        const chain = await Promise.race([
          client.getChainSpecData(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Connection timed out")), 10000)
          ),
        ]);

        // Bail if a newer connect call was started (React strict mode)
        if (connectIdRef.current !== id) return;

        setChainName(chain.name);
        setConnected(true);

        // Detect available pallets
        const detected = { templatePallet: false, revive: false };

        try {
          const api = client.getTypedApi(stack_template);
          await api.query.TemplatePallet.Claims.getEntries();
          detected.templatePallet = true;
        } catch {
          detected.templatePallet = false;
        }

        try {
          const api = client.getTypedApi(stack_template);
          await api.constants.Revive.DepositPerByte();
          detected.revive = true;
        } catch {
          detected.revive = false;
        }

        if (connectIdRef.current !== id) return;
        setPallets(detected);
      } catch (e) {
        if (connectIdRef.current !== id) return;
        setError(`Could not connect to ${url}. Is the chain running?`);
        setPallets({ templatePallet: false, revive: false });
        console.error(e);
      } finally {
        if (connectIdRef.current === id) {
          setConnecting(false);
        }
      }
    },
    [setConnected, setPallets]
  );

  // Connect on mount (skip if already connected)
  useEffect(() => {
    if (!connected) {
      connect(wsUrl);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to blocks when connected
  useEffect(() => {
    if (!connected) return;
    const client = getClient(wsUrl);
    const subscription = client.finalizedBlock$.subscribe((block) => {
      setBlockNumber(block.number);
    });
    return () => subscription.unsubscribe();
  }, [connected, wsUrl, setBlockNumber]);

  function handleConnect() {
    setWsUrl(urlInput);
    connect(urlInput);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Polkadot Stack Template</h1>
      <p className="text-gray-400">
        A developer starter template demonstrating Proof of Existence
        implemented three ways: as a Substrate pallet, a Solidity EVM contract,
        and a PVM contract (Solidity compiled via resolc). Drop a file to claim
        its hash on-chain.
      </p>

      <div className="bg-gray-900 rounded-lg p-5 border border-gray-800 space-y-4">
        <div>
          <label className="text-sm text-gray-400 block mb-1">
            WebSocket Endpoint
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleConnect()}
              placeholder="ws://127.0.0.1:9944"
              className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white flex-1 font-mono text-sm"
            />
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="px-4 py-2 bg-pink-600 hover:bg-pink-700 disabled:opacity-50 rounded text-white text-sm"
            >
              {connecting ? "Connecting..." : "Connect"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-1">
              Chain Status
            </h3>
            <p className="text-xl font-bold">
              {error ? (
                <span className="text-red-400 text-sm">{error}</span>
              ) : connected ? (
                <span className="text-green-400">Connected</span>
              ) : connecting ? (
                <span className="text-yellow-400">Connecting...</span>
              ) : (
                <span className="text-gray-500">Disconnected</span>
              )}
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-1">
              Chain Name
            </h3>
            <p className="text-xl font-bold">{chainName}</p>
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-1">
              Latest Block
            </h3>
            <p className="text-xl font-bold font-mono">#{blockNumber}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card
          title="Pallet PoE"
          description="Claim file hashes via the Substrate FRAME pallet using PAPI."
          link="/pallet"
          color="text-blue-400"
          available={pallets.templatePallet}
          unavailableReason="TemplatePallet not found in connected runtime"
        />
        <Card
          title="EVM PoE (solc)"
          description="Same proof of existence via Solidity compiled with solc, deployed to the EVM backend."
          link="/evm"
          color="text-purple-400"
          available={pallets.revive}
          unavailableReason="pallet-revive not found in connected runtime"
        />
        <Card
          title="PVM PoE (resolc)"
          description="Same Solidity contract compiled with resolc to PolkaVM bytecode, deployed via pallet-revive."
          link="/pvm"
          color="text-green-400"
          available={pallets.revive}
          unavailableReason="pallet-revive not found in connected runtime"
        />
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  link,
  color,
  available,
  unavailableReason,
}: {
  title: string;
  description: string;
  link: string;
  color: string;
  available: boolean | null;
  unavailableReason: string;
}) {
  if (available !== true) {
    return (
      <div className="bg-gray-900 rounded-lg p-5 border border-gray-800 opacity-50">
        <h3 className="text-lg font-semibold mb-2 text-gray-500">{title}</h3>
        <p className="text-sm text-gray-500">{description}</p>
        <p className="text-xs mt-2">
          {available === null ? (
            <span className="text-yellow-400">Detecting...</span>
          ) : (
            <span className="text-red-400">{unavailableReason}</span>
          )}
        </p>
      </div>
    );
  }

  return (
    <a
      href={`#${link}`}
      className="bg-gray-900 rounded-lg p-5 border border-gray-800 hover:border-gray-600 transition-colors block"
    >
      <h3 className={`text-lg font-semibold mb-2 ${color}`}>{title}</h3>
      <p className="text-sm text-gray-400">{description}</p>
    </a>
  );
}
