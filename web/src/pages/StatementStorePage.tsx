import { useState, useEffect } from "react";
import { useChainStore } from "../store/chainStore";
import {
	checkStatementStoreAvailable,
	fetchStatements,
	type DecodedStatement,
} from "../hooks/useStatementStore";

export default function StatementStorePage() {
	const wsUrl = useChainStore((s) => s.wsUrl);
	const [available, setAvailable] = useState<boolean | null>(null);
	const [statements, setStatements] = useState<DecodedStatement[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		checkStatementStoreAvailable(wsUrl).then((ok) => {
			setAvailable(ok);
			if (ok) loadStatements();
		});
	}, [wsUrl]); // eslint-disable-line react-hooks/exhaustive-deps

	async function loadStatements() {
		try {
			setLoading(true);
			setError(null);
			const result = await fetchStatements(wsUrl);
			setStatements(result);
		} catch (e) {
			console.error("Failed to fetch statements:", e);
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}

	function tryDecodeUtf8(data: Uint8Array | null): string | null {
		if (!data) return null;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
			if (/^[\x20-\x7e\t\n\r]+$/.test(text)) return text;
		} catch {
			// not valid utf-8
		}
		return null;
	}

	function detectFileType(data: Uint8Array): { ext: string; mime: string } {
		if (data.length >= 4) {
			// PNG: 89 50 4E 47
			if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
				return { ext: "png", mime: "image/png" };
			// GIF: 47 49 46 38
			if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
				return { ext: "gif", mime: "image/gif" };
			// PDF: 25 50 44 46
			if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46)
				return { ext: "pdf", mime: "application/pdf" };
			// ZIP: 50 4B 03 04
			if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04)
				return { ext: "zip", mime: "application/zip" };
			// WASM: 00 61 73 6D
			if (data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d)
				return { ext: "wasm", mime: "application/wasm" };
		}
		if (data.length >= 3) {
			// JPEG: FF D8 FF
			if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
				return { ext: "jpg", mime: "image/jpeg" };
		}
		// WebP: RIFF....WEBP
		if (
			data.length >= 12 &&
			data[0] === 0x52 &&
			data[1] === 0x49 &&
			data[2] === 0x46 &&
			data[3] === 0x46 &&
			data[8] === 0x57 &&
			data[9] === 0x45 &&
			data[10] === 0x42 &&
			data[11] === 0x50
		)
			return { ext: "webp", mime: "image/webp" };

		// Text-based detection
		const text = tryDecodeUtf8(data);
		if (text !== null) {
			const trimmed = text.trimStart();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					JSON.parse(trimmed);
					return { ext: "json", mime: "application/json" };
				} catch {
					/* not valid JSON */
				}
			}
			return { ext: "txt", mime: "text/plain" };
		}

		return { ext: "bin", mime: "application/octet-stream" };
	}

	function downloadData(data: Uint8Array, hash: string) {
		const { ext, mime } = detectFileType(data);
		const blob = new Blob([data], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `statement-${hash.slice(2, 10)}.${ext}`;
		a.click();
		URL.revokeObjectURL(url);
	}

	if (available === null) {
		return (
			<div className="space-y-6 animate-fade-in">
				<h1 className="page-title text-accent-orange">Statement Store</h1>
				<p className="text-text-muted text-sm">Checking availability...</p>
			</div>
		);
	}

	if (!available) {
		return (
			<div className="space-y-6 animate-fade-in">
				<h1 className="page-title text-accent-orange">Statement Store</h1>
				<p className="text-text-secondary">
					View statements stored in the node's local Statement Store.
				</p>
				<div className="card">
					<p className="text-text-muted text-sm">
						The connected node does not expose Statement Store RPCs. In polkadot-sdk
						stable2512-3, the statement store is only available in the relay-backed
						path. Use{" "}
						<code className="text-text-secondary font-mono text-xs">
							./scripts/start-all.sh
						</code>{" "}
						to start the full environment, or{" "}
						<code className="text-text-secondary font-mono text-xs">
							./scripts/start-local.sh
						</code>{" "}
						for just the relay-backed network.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6 animate-fade-in">
			<div className="space-y-2">
				<h1 className="page-title text-accent-orange">Statement Store</h1>
				<p className="text-text-secondary">
					View statements stored in the node's local Statement Store. Statements are
					off-chain data propagated across the peer-to-peer network.
				</p>
			</div>

			<div className="card space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="section-title">
						Statements{" "}
						<span className="text-text-muted text-sm font-normal">
							({statements.length})
						</span>
					</h2>
					<button
						onClick={loadStatements}
						disabled={loading}
						className="btn-secondary text-xs"
					>
						{loading ? "Loading..." : "Refresh"}
					</button>
				</div>

				{error && <p className="text-accent-red text-sm font-medium">{error}</p>}

				{statements.length === 0 && !loading && !error && (
					<p className="text-text-muted text-sm">No statements in the store.</p>
				)}

				<div className="space-y-2">
					{statements.map((stmt, i) => {
						const textPreview = tryDecodeUtf8(stmt.data);
						return (
							<div
								key={i}
								className="rounded-lg border border-white/[0.04] bg-white/[0.02] p-3 text-sm space-y-1.5"
							>
								<p className="font-mono text-xs text-text-secondary break-all">
									{stmt.hash}
								</p>
								<p className="text-text-tertiary">
									{stmt.proofType && (
										<>
											Proof:{" "}
											<span className="text-text-secondary">
												{stmt.proofType}
											</span>{" "}
											|{" "}
										</>
									)}
									{stmt.signer && (
										<>
											Signer:{" "}
											<span className="text-text-secondary font-mono text-xs">
												{stmt.signer.slice(0, 10)}...{stmt.signer.slice(-6)}
											</span>{" "}
											|{" "}
										</>
									)}
									Data:{" "}
									<span className="text-text-secondary">
										{stmt.dataLength.toLocaleString()} bytes
									</span>
									{stmt.topics.length > 0 && (
										<>
											{" "}
											| Topics:{" "}
											<span className="text-text-secondary">
												{stmt.topics.length}
											</span>
										</>
									)}
									{stmt.priority !== null && (
										<>
											{" "}
											| Priority:{" "}
											<span className="text-text-secondary">
												{stmt.priority}
											</span>
										</>
									)}
								</p>
								{textPreview && (
									<pre className="text-xs text-text-muted rounded-md border border-white/[0.04] bg-white/[0.02] px-2 py-1.5 mt-1.5 overflow-x-auto max-h-24 font-mono">
										{textPreview.length > 500
											? textPreview.slice(0, 500) + "..."
											: textPreview}
									</pre>
								)}
								{stmt.data && (
									<button
										onClick={() => downloadData(stmt.data!, stmt.hash)}
										className="mt-1 btn-secondary text-xs py-1"
									>
										Download
									</button>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
