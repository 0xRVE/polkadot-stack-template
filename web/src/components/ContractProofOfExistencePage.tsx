import { useState, useCallback, useEffect, type ReactNode } from "react";
import { type Address } from "viem";
import {
	proofOfExistenceAbi,
	evmDevAccounts,
	getPublicClient,
	getWalletClient,
} from "../config/evm";
import { devAccounts } from "../hooks/useAccount";
import FileDropZone from "./FileDropZone";
import { hexHashToCid, ipfsUrl, checkIpfsAvailable } from "../utils/cid";
import { uploadToBulletin, checkBulletinAuthorization } from "../hooks/useBulletin";
import { submitToStatementStore, checkStatementStoreAvailable } from "../hooks/useStatementStore";
import { getDevKeypair } from "../hooks/useAccount";
import { useChainStore } from "../store/chainStore";

interface Props {
	title: string;
	description: ReactNode;
	contractKind: "evm" | "pvm";
	accentColor: "purple" | "green";
	storageKey: string;
	defaultAddress?: string;
}

interface Claim {
	hash: `0x${string}`;
	owner: string;
	block: bigint;
}

const colorMap = {
	purple: {
		title: "text-accent-purple",
		gradient: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)",
	},
	green: {
		title: "text-accent-green",
		gradient: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
	},
};

export default function ContractProofOfExistencePage({
	title,
	description,
	contractKind,
	accentColor,
	storageKey,
	defaultAddress,
}: Props) {
	const colors = colorMap[accentColor];
	const ethRpcUrl = useChainStore((s) => s.ethRpcUrl);
	const wsUrl = useChainStore((s) => s.wsUrl);
	const scopedStorageKey = `${storageKey}:${ethRpcUrl}`;
	const [contractAddress, setContractAddress] = useState("");
	const [selectedAccount, setSelectedAccount] = useState(0);
	const [fileHash, setFileHash] = useState<`0x${string}` | null>(null);
	const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
	const [uploadToIpfs, setUploadToIpfs] = useState(false);
	const [uploadToStatementStore, setUploadToStatementStore] = useState(false);
	const [claims, setClaims] = useState<Claim[]>([]);
	const [txStatus, setTxStatus] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [ipfsAvailable, setIpfsAvailable] = useState<Record<string, boolean>>({});
	const [statementStoreAvailable, setStatementStoreAvailable] = useState<boolean | null>(null);

	useEffect(() => {
		setContractAddress(localStorage.getItem(scopedStorageKey) || defaultAddress || "");
	}, [defaultAddress, scopedStorageKey]);

	useEffect(() => {
		checkStatementStoreAvailable(wsUrl).then(setStatementStoreAvailable);
	}, [wsUrl]);

	useEffect(() => {
		if (contractAddress) {
			loadClaims();
		} else {
			setClaims([]);
			setTxStatus(null);
		}
	}, [contractAddress, ethRpcUrl]); // eslint-disable-line react-hooks/exhaustive-deps

	function saveAddress(address: string) {
		setContractAddress(address);
		if (address) {
			localStorage.setItem(scopedStorageKey, address);
		} else {
			localStorage.removeItem(scopedStorageKey);
		}
	}

	function missingContractMessage() {
		return [
			`Error: No ${contractKind.toUpperCase()} contract was found at this address on ${ethRpcUrl}.`,
			`Update the address or deploy one with: cd contracts/${contractKind} && npm run deploy:local (local dev) or npm run deploy:testnet (testnet).`,
		].join(" ");
	}

	const onFileHashed = useCallback((hash: `0x${string}`) => {
		setFileHash(hash);
	}, []);

	const onFileBytes = useCallback((bytes: Uint8Array) => {
		setFileBytes(bytes);
	}, []);

	async function loadClaims() {
		if (!contractAddress) {
			setTxStatus("Error: Enter a contract address first");
			return;
		}
		try {
			setLoading(true);
			setTxStatus(null);
			const client = getPublicClient(ethRpcUrl);
			const addr = contractAddress as Address;

			// Check if contract is actually deployed at this address
			const code = await client.getCode({ address: addr });
			if (!code || code === "0x") {
				setClaims([]);
				setTxStatus(missingContractMessage());
				return;
			}

			const count = await client.readContract({
				address: addr,
				abi: proofOfExistenceAbi,
				functionName: "getClaimCount",
			});
			const result: Claim[] = [];
			for (let i = 0n; i < count; i++) {
				const hash = await client.readContract({
					address: addr,
					abi: proofOfExistenceAbi,
					functionName: "getClaimHashAtIndex",
					args: [i],
				});
				const [owner, block] = await client.readContract({
					address: addr,
					abi: proofOfExistenceAbi,
					functionName: "getClaim",
					args: [hash],
				});
				result.push({ hash, owner, block });
			}
			setClaims(result);
			// Check IPFS availability in background
			result.forEach((claim) => {
				const cid = hexHashToCid(claim.hash);
				checkIpfsAvailable(cid).then((available) => {
					if (available) {
						setIpfsAvailable((prev) => ({ ...prev, [claim.hash]: true }));
					}
				});
			});
		} catch (e) {
			console.error("Failed to load claims:", e);
			setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
		} finally {
			setLoading(false);
		}
	}

	async function createClaim() {
		if (!contractAddress || !fileHash) {
			setTxStatus("Error: Select a file and enter a contract address");
			return;
		}
		try {
			const client = getPublicClient(ethRpcUrl);
			const code = await client.getCode({ address: contractAddress as Address });
			if (!code || code === "0x") {
				setTxStatus(missingContractMessage());
				return;
			}
			// Optional: upload to Bulletin Chain first (using Substrate signer)
			if (uploadToIpfs && fileBytes) {
				const substrateSigner = devAccounts[selectedAccount].signer;
				const substrateAddress = devAccounts[selectedAccount].address;

				setTxStatus("Checking Bulletin Chain authorization...");
				const authorized = await checkBulletinAuthorization(
					substrateAddress,
					fileBytes.length,
				);
				if (!authorized) {
					setTxStatus(
						"Error: Not authorized to upload to Bulletin Chain. Authorization is required via chain governance.",
					);
					return;
				}
				setTxStatus("Uploading to Bulletin Chain (IPFS)...");
				await uploadToBulletin(fileBytes, substrateSigner);
				setTxStatus("Upload complete. Submitting claim...");
			}

			// Optional: submit to Statement Store
			if (uploadToStatementStore && fileBytes) {
				setTxStatus("Submitting to Statement Store...");
				const keypair = getDevKeypair(selectedAccount);
				await submitToStatementStore(wsUrl, fileBytes, keypair.publicKey, keypair.sign);
				setTxStatus("Statement Store submission complete. Submitting claim...");
			}

			if (!uploadToIpfs && !uploadToStatementStore) {
				setTxStatus("Submitting createClaim...");
			}

			const walletClient = await getWalletClient(selectedAccount, ethRpcUrl);
			const hash = await walletClient.writeContract({
				address: contractAddress as Address,
				abi: proofOfExistenceAbi,
				functionName: "createClaim",
				args: [fileHash],
			});
			setTxStatus(`Transaction submitted: ${hash}`);
			const publicClient = getPublicClient(ethRpcUrl);
			await publicClient.waitForTransactionReceipt({ hash });
			setTxStatus("Claim created!");
			setFileHash(null);
			setFileBytes(null);
			loadClaims();
		} catch (e) {
			console.error("Transaction failed:", e);
			setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	async function revokeClaim(documentHash: `0x${string}`) {
		if (!contractAddress) return;
		try {
			const client = getPublicClient(ethRpcUrl);
			const code = await client.getCode({ address: contractAddress as Address });
			if (!code || code === "0x") {
				setTxStatus(missingContractMessage());
				return;
			}
			setTxStatus("Submitting revokeClaim...");
			const walletClient = await getWalletClient(selectedAccount, ethRpcUrl);
			const hash = await walletClient.writeContract({
				address: contractAddress as Address,
				abi: proofOfExistenceAbi,
				functionName: "revokeClaim",
				args: [documentHash],
			});
			setTxStatus(`Transaction submitted: ${hash}`);
			const publicClient = getPublicClient(ethRpcUrl);
			await publicClient.waitForTransactionReceipt({ hash });
			setTxStatus("Claim revoked!");
			loadClaims();
		} catch (e) {
			console.error("Transaction failed:", e);
			setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	const currentAddress = evmDevAccounts[selectedAccount].account.address;

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className={`page-title ${colors.title}`}>{title}</h1>
				<p className="text-text-secondary">{description}</p>
			</div>

			<div className="card space-y-4">
				<div>
					<label className="label">Contract Address</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={contractAddress}
							onChange={(e) => saveAddress(e.target.value)}
							placeholder="0x..."
							className="input-field w-full"
						/>
						{defaultAddress && contractAddress !== defaultAddress && (
							<button
								onClick={() => saveAddress(defaultAddress)}
								className="btn-secondary text-xs whitespace-nowrap"
							>
								Reset
							</button>
						)}
					</div>
				</div>

				<div>
					<label className="label">Dev Account</label>
					<select
						value={selectedAccount}
						onChange={(e) => setSelectedAccount(parseInt(e.target.value))}
						className="input-field w-full"
					>
						{evmDevAccounts.map((acc, i) => (
							<option key={i} value={i}>
								{acc.name} ({acc.account.address})
							</option>
						))}
					</select>
				</div>

				<FileDropZone
					onFileHashed={onFileHashed}
					onFileBytes={onFileBytes}
					showUploadToggle={true}
					uploadToIpfs={uploadToIpfs}
					onUploadToggle={setUploadToIpfs}
					showStatementStoreToggle={true}
					uploadToStatementStore={uploadToStatementStore}
					onStatementStoreToggle={setUploadToStatementStore}
					statementStoreDisabled={statementStoreAvailable === false}
				/>

				{fileHash && (
					<div className="space-y-3">
						<p className="text-sm text-text-secondary">
							Blake2b-256:{" "}
							<code className="text-text-primary font-mono text-xs break-all">
								{fileHash}
							</code>
						</p>
						<button
							onClick={createClaim}
							className="btn-accent"
							style={{
								background: colors.gradient,
								boxShadow:
									"0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)",
							}}
						>
							Create Claim
						</button>
					</div>
				)}

				{txStatus && (
					<p
						className={`text-sm font-medium ${txStatus.startsWith("Error") ? "text-accent-red" : "text-accent-green"}`}
					>
						{txStatus}
					</p>
				)}
			</div>

			<div className="card space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="section-title">Claims</h2>
					<button
						onClick={loadClaims}
						disabled={loading}
						className="btn-secondary text-xs"
					>
						{loading ? "Loading..." : "Refresh"}
					</button>
				</div>

				{claims.length === 0 ? (
					<p className="text-text-muted text-sm">
						No claims found. Click Refresh to load.
					</p>
				) : (
					<div className="space-y-2">
						{claims.map((claim) => {
							const cid = hexHashToCid(claim.hash);
							return (
								<div
									key={claim.hash}
									className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 text-sm space-y-1.5"
								>
									<p className="font-mono text-xs text-text-secondary break-all">
										{claim.hash}
									</p>
									<p className="text-text-tertiary">
										Owner:{" "}
										<span className="text-text-secondary">
											{claim.owner.slice(0, 8)}...{claim.owner.slice(-4)}
										</span>{" "}
										| Block:{" "}
										<span className="text-text-secondary">
											{claim.block.toString()}
										</span>{" "}
										{ipfsAvailable[claim.hash] && (
											<>
												{" "}
												|{" "}
												<a
													href={ipfsUrl(cid)}
													target="_blank"
													rel="noopener noreferrer"
													className="text-accent-blue hover:underline"
												>
													View on IPFS
												</a>
											</>
										)}
									</p>
									{claim.owner.toLowerCase() === currentAddress.toLowerCase() && (
										<button
											onClick={() => revokeClaim(claim.hash)}
											className="px-2 py-1 rounded-md bg-accent-red/10 text-accent-red text-xs font-medium hover:bg-accent-red/20 transition-colors"
										>
											Revoke
										</button>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
