import { useState, useCallback, useEffect } from "react";
import { useChainStore } from "../store/chainStore";
import { devAccounts } from "../hooks/useAccount";
import { getClient } from "../hooks/useChain";
import { stack_template } from "@polkadot-api/descriptors";
import { Binary } from "polkadot-api";
import FileDropZone from "../components/FileDropZone";
import { hexHashToCid, ipfsUrl, checkIpfsAvailable } from "../utils/cid";
import { formatDispatchError } from "../utils/format";
import { uploadToBulletin, checkBulletinAuthorization } from "../hooks/useBulletin";
import { submitToStatementStore, checkStatementStoreAvailable } from "../hooks/useStatementStore";
import { getDevKeypair } from "../hooks/useAccount";

interface Claim {
	hash: string;
	owner: string;
	block: number;
}

export default function PalletPage() {
	const { selectedAccount, setSelectedAccount, setTxStatus, txStatus, wsUrl } = useChainStore();
	const [fileHash, setFileHash] = useState<`0x${string}` | null>(null);
	const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null);
	const [uploadToIpfs, setUploadToIpfs] = useState(false);
	const [uploadToStatementStore, setUploadToStatementStore] = useState(false);
	const [claims, setClaims] = useState<Claim[]>([]);
	const [loading, setLoading] = useState(false);
	const [ipfsAvailable, setIpfsAvailable] = useState<Record<string, boolean>>({});
	const [statementStoreAvailable, setStatementStoreAvailable] = useState<boolean | null>(null);

	const account = devAccounts[selectedAccount];

	useEffect(() => {
		loadClaims();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		checkStatementStoreAvailable(wsUrl).then(setStatementStoreAvailable);
	}, [wsUrl]);

	function getApi() {
		const client = getClient(wsUrl);
		return client.getTypedApi(stack_template);
	}

	const onFileHashed = useCallback((hash: `0x${string}`) => {
		setFileHash(hash);
	}, []);

	const onFileBytes = useCallback((bytes: Uint8Array) => {
		setFileBytes(bytes);
	}, []);

	async function loadClaims() {
		try {
			setLoading(true);
			const api = getApi();
			const entries = await api.query.TemplatePallet.Claims.getEntries();
			const result: Claim[] = entries.map((entry) => ({
				hash: entry.keyArgs[0].asHex(),
				owner: entry.value.owner.toString(),
				block: Number(entry.value.block_number),
			}));
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
		} finally {
			setLoading(false);
		}
	}

	async function createClaim() {
		if (!fileHash) return;
		try {
			// Optional: upload to Bulletin Chain first
			if (uploadToIpfs && fileBytes) {
				setTxStatus("Checking Bulletin Chain authorization...");
				const authorized = await checkBulletinAuthorization(
					account.address,
					fileBytes.length,
				);
				if (!authorized) {
					setTxStatus(
						"Error: Not authorized to upload to Bulletin Chain. Authorization is required via chain governance.",
					);
					return;
				}
				setTxStatus("Uploading to Bulletin Chain (IPFS)...");
				await uploadToBulletin(fileBytes, account.signer);
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
				setTxStatus("Submitting create_claim...");
			}

			const api = getApi();
			const tx = api.tx.TemplatePallet.create_claim({
				hash: Binary.fromHex(fileHash),
			});
			const result = await tx.signAndSubmit(account.signer);
			if (!result.ok) {
				setTxStatus(`Error: ${formatDispatchError(result.dispatchError)}`);
				return;
			}
			setTxStatus("Claim created successfully!");
			setFileHash(null);
			setFileBytes(null);
			loadClaims();
		} catch (e) {
			console.error("Transaction failed:", e);
			setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	async function revokeClaim(hash: string) {
		try {
			setTxStatus("Submitting revoke_claim...");
			const api = getApi();
			const tx = api.tx.TemplatePallet.revoke_claim({
				hash: Binary.fromHex(hash),
			});
			const result = await tx.signAndSubmit(account.signer);
			if (!result.ok) {
				setTxStatus(`Error: ${formatDispatchError(result.dispatchError)}`);
				return;
			}
			setTxStatus("Claim revoked successfully!");
			loadClaims();
		} catch (e) {
			console.error("Transaction failed:", e);
			setTxStatus(`Error: ${e instanceof Error ? e.message : e}`);
		}
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-accent-blue">Pallet Proof of Existence</h1>
				<p className="text-text-secondary">
					Claim ownership of file hashes on-chain via the Substrate FRAME pallet. Uses
					PAPI to submit extrinsics and read storage.
				</p>
			</div>

			<div className="card space-y-4">
				<div>
					<label className="label">Dev Account</label>
					<select
						value={selectedAccount}
						onChange={(e) => setSelectedAccount(parseInt(e.target.value))}
						className="input-field w-full"
					>
						{devAccounts.map((acc, i) => (
							<option key={i} value={i}>
								{acc.name}
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
								background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",
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
											{claim.owner.slice(0, 8)}...{claim.owner.slice(-6)}
										</span>{" "}
										| Block:{" "}
										<span className="text-text-secondary">{claim.block}</span>
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
									{claim.owner === account.address && (
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
