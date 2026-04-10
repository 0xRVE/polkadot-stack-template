import { useState, useCallback, type DragEvent } from "react";
import { hashFileWithBytes } from "../utils/hash";

interface Props {
	onFileHashed: (hash: `0x${string}`, fileName: string) => void;
	onFileBytes?: (bytes: Uint8Array) => void;
	showUploadToggle?: boolean;
	uploadToIpfs?: boolean;
	onUploadToggle?: (enabled: boolean) => void;
	showStatementStoreToggle?: boolean;
	uploadToStatementStore?: boolean;
	onStatementStoreToggle?: (enabled: boolean) => void;
	statementStoreDisabled?: boolean;
}

export default function FileDropZone({
	onFileHashed,
	onFileBytes,
	showUploadToggle,
	uploadToIpfs,
	onUploadToggle,
	showStatementStoreToggle,
	uploadToStatementStore,
	onStatementStoreToggle,
	statementStoreDisabled,
}: Props) {
	const [dragging, setDragging] = useState(false);
	const [fileName, setFileName] = useState<string | null>(null);
	const [hashing, setHashing] = useState(false);

	const processFile = useCallback(
		async (file: File) => {
			setFileName(file.name);
			setHashing(true);
			try {
				const { hash, bytes } = await hashFileWithBytes(file);
				onFileHashed(hash, file.name);
				onFileBytes?.(bytes);
			} finally {
				setHashing(false);
			}
		},
		[onFileHashed, onFileBytes],
	);

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		setDragging(false);
		const file = e.dataTransfer.files[0];
		if (file) processFile(file);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		setDragging(true);
	}

	function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (file) processFile(file);
	}

	return (
		<div className="space-y-3">
			<div
				onDrop={handleDrop}
				onDragOver={handleDragOver}
				onDragLeave={() => setDragging(false)}
				className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-300 cursor-pointer ${
					dragging
						? "border-polka-500 bg-polka-500/[0.06] shadow-glow"
						: "border-white/[0.08] hover:border-white/[0.15] hover:bg-white/[0.02]"
				}`}
			>
				<input type="file" onChange={handleFileInput} className="hidden" id="file-input" />
				<label htmlFor="file-input" className="cursor-pointer">
					{hashing ? (
						<p className="text-accent-yellow font-medium">Hashing...</p>
					) : fileName ? (
						<p className="text-text-primary">
							{fileName}{" "}
							<span className="text-text-muted text-sm">
								(drop another to replace)
							</span>
						</p>
					) : (
						<div className="space-y-1">
							<p className="text-text-secondary font-medium">
								Drop a file here or click to select
							</p>
							<p className="text-text-muted text-xs">
								The file will be hashed locally with Blake2b-256
							</p>
						</div>
					)}
				</label>
			</div>
			{showUploadToggle && (
				<label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
					<input
						type="checkbox"
						checked={uploadToIpfs ?? false}
						onChange={(e) => onUploadToggle?.(e.target.checked)}
						className="rounded border-white/[0.15] bg-white/[0.04] text-polka-500 focus:ring-polka-500/30"
					/>
					Upload file to IPFS (via Bulletin Chain)
					<a
						href="https://paritytech.github.io/polkadot-bulletin-chain/"
						target="_blank"
						rel="noopener noreferrer"
						className="text-text-muted text-xs hover:text-text-secondary underline"
					>
						— requires authorization, expires ~7 days
					</a>
				</label>
			)}
			{showStatementStoreToggle && (
				<label
					className={`flex items-center gap-2 text-sm cursor-pointer ${statementStoreDisabled ? "text-text-muted" : "text-text-secondary"}`}
				>
					<input
						type="checkbox"
						checked={uploadToStatementStore ?? false}
						onChange={(e) => onStatementStoreToggle?.(e.target.checked)}
						disabled={statementStoreDisabled}
						className="rounded border-white/[0.15] bg-white/[0.04] text-polka-500 focus:ring-polka-500/30"
					/>
					Submit file to Statement Store
					<span className="text-text-muted text-xs">
						{statementStoreDisabled
							? "— not available (node lacks statement_submit RPC)"
							: "— propagates to connected nodes, short-term"}
					</span>
				</label>
			)}
		</div>
	);
}
