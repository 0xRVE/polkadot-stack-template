import { useEffect, useState } from "react";
import { useChainStore } from "../store/chainStore";
import { useConnection } from "../hooks/useConnection";
import { getClient } from "../hooks/useChain";
import {
	LOCAL_ETH_RPC_URL,
	LOCAL_WS_URL,
	getNetworkPresetEndpoints,
	type NetworkPreset,
} from "../config/network";

export default function HomePage() {
	const { wsUrl, ethRpcUrl, setEthRpcUrl, connected, blockNumber, pallets } = useChainStore();
	const { connect } = useConnection();
	const [urlInput, setUrlInput] = useState(wsUrl);
	const [ethRpcInput, setEthRpcInput] = useState(ethRpcUrl);
	const [error, setError] = useState<string | null>(null);
	const [chainName, setChainName] = useState<string | null>(null);
	const [connecting, setConnecting] = useState(false);

	useEffect(() => {
		setUrlInput(wsUrl);
	}, [wsUrl]);

	useEffect(() => {
		setEthRpcInput(ethRpcUrl);
	}, [ethRpcUrl]);

	useEffect(() => {
		if (!connected) {
			return;
		}

		getClient(wsUrl)
			.getChainSpecData()
			.then((data) => setChainName(data.name))
			.catch(() => {});
	}, [connected, wsUrl]);

	async function handleConnect() {
		setConnecting(true);
		setError(null);
		setChainName(null);
		try {
			const result = await connect(urlInput);
			if (result?.ok && result.chain) {
				setChainName(result.chain.name);
			}
		} catch (e) {
			setError(`Could not connect to ${urlInput}. Is the chain running?`);
			console.error(e);
		} finally {
			setConnecting(false);
		}
	}

	function applyPreset(preset: NetworkPreset) {
		const endpoints = getNetworkPresetEndpoints(preset);
		setUrlInput(endpoints.wsUrl);
		setEthRpcInput(endpoints.ethRpcUrl);
		setEthRpcUrl(endpoints.ethRpcUrl);
	}

	return (
		<div className="space-y-8 animate-fade-in">
			{/* Hero */}
			<div className="space-y-3">
				<h1 className="page-title">
					Polkadot Stack{" "}
					<span className="bg-gradient-to-r from-polka-400 to-polka-600 bg-clip-text text-transparent">
						Template
					</span>
				</h1>
				<p className="text-text-secondary text-base leading-relaxed max-w-2xl">
					A developer starter template demonstrating Proof of Existence implemented three
					ways: as a Substrate pallet, a Solidity EVM contract, and a PVM contract. Drop a
					file to claim its hash on-chain.
				</p>
			</div>

			{/* Connection card */}
			<div className="card space-y-5">
				<div className="flex flex-wrap gap-2">
					<button onClick={() => applyPreset("local")} className="btn-secondary text-xs">
						Use Local Dev
					</button>
					<button
						onClick={() => applyPreset("testnet")}
						className="btn-secondary text-xs"
					>
						Use Hub TestNet
					</button>
				</div>

				<div>
					<label className="label">Substrate WebSocket Endpoint</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={urlInput}
							onChange={(e) => setUrlInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleConnect()}
							placeholder={LOCAL_WS_URL}
							className="input-field flex-1"
						/>
						<button
							onClick={handleConnect}
							disabled={connecting}
							className="btn-primary"
						>
							{connecting ? "Connecting..." : "Connect"}
						</button>
					</div>
				</div>

				<div>
					<label className="label">Ethereum JSON-RPC Endpoint</label>
					<input
						type="text"
						value={ethRpcInput}
						onChange={(e) => {
							setEthRpcInput(e.target.value);
							setEthRpcUrl(e.target.value);
						}}
						placeholder={LOCAL_ETH_RPC_URL}
						className="input-field w-full"
					/>
					<p className="text-xs text-text-muted mt-2">
						Used by the EVM and PVM contract pages.
					</p>
				</div>

				{/* Status grid */}
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					<StatusItem label="Chain Status">
						{error ? (
							<span className="text-accent-red text-sm">{error}</span>
						) : connected ? (
							<span className="text-accent-green flex items-center gap-1.5">
								<span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse-slow" />
								Connected
							</span>
						) : connecting ? (
							<span className="text-accent-yellow">Connecting...</span>
						) : (
							<span className="text-text-muted">Disconnected</span>
						)}
					</StatusItem>
					<StatusItem label="Chain Name">
						{chainName || <span className="text-text-muted">...</span>}
					</StatusItem>
					<StatusItem label="Latest Block">
						<span className="font-mono">#{blockNumber}</span>
					</StatusItem>
				</div>
			</div>

			{/* Feature cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<FeatureCard
					title="Pallet PoE"
					description="Claim file hashes via the Substrate FRAME pallet using PAPI."
					link="/pallet"
					accentColor="text-accent-blue"
					borderColor="hover:border-accent-blue/20"
					available={pallets.templatePallet}
					unavailableReason="TemplatePallet not found in connected runtime"
				/>
				<FeatureCard
					title="EVM PoE (solc)"
					description="Same proof of existence via Solidity compiled with solc, deployed to the EVM backend."
					link="/evm"
					accentColor="text-accent-purple"
					borderColor="hover:border-accent-purple/20"
					available={pallets.revive}
					unavailableReason="pallet-revive not found in connected runtime"
				/>
				<FeatureCard
					title="PVM PoE (resolc)"
					description="Same Solidity contract compiled with resolc to PolkaVM bytecode, deployed via pallet-revive."
					link="/pvm"
					accentColor="text-accent-green"
					borderColor="hover:border-accent-green/20"
					available={pallets.revive}
					unavailableReason="pallet-revive not found in connected runtime"
				/>
			</div>
		</div>
	);
}

function StatusItem({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-1">
				{label}
			</h3>
			<p className="text-lg font-semibold text-text-primary">{children}</p>
		</div>
	);
}

function FeatureCard({
	title,
	description,
	link,
	accentColor,
	borderColor,
	available,
	unavailableReason,
}: {
	title: string;
	description: string;
	link: string;
	accentColor: string;
	borderColor: string;
	available: boolean | null;
	unavailableReason: string;
}) {
	if (available !== true) {
		return (
			<div className="card opacity-40">
				<h3 className="text-lg font-semibold mb-2 text-text-muted font-display">{title}</h3>
				<p className="text-sm text-text-muted">{description}</p>
				<p className="text-xs mt-3">
					{available === null ? (
						<span className="text-accent-yellow">Detecting...</span>
					) : (
						<span className="text-accent-red">{unavailableReason}</span>
					)}
				</p>
			</div>
		);
	}

	return (
		<a href={`#${link}`} className={`card-hover block group ${borderColor}`}>
			<h3 className={`text-lg font-semibold mb-2 font-display ${accentColor}`}>{title}</h3>
			<p className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
				{description}
			</p>
		</a>
	);
}
