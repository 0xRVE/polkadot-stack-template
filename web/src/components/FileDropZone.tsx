import { useState, useCallback, type DragEvent } from "react";
import { hashFileWithBytes } from "../utils/hash";

interface Props {
  onFileHashed: (hash: `0x${string}`, fileName: string) => void;
  onFileBytes?: (bytes: Uint8Array) => void;
  showUploadToggle?: boolean;
  uploadToIpfs?: boolean;
  onUploadToggle?: (enabled: boolean) => void;
}

export default function FileDropZone({
  onFileHashed,
  onFileBytes,
  showUploadToggle,
  uploadToIpfs,
  onUploadToggle,
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
    [onFileHashed, onFileBytes]
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
    <div className="space-y-2">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragging(false)}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
          dragging
            ? "border-pink-500 bg-pink-500/10"
            : "border-gray-700 hover:border-gray-500"
        }`}
      >
        <input
          type="file"
          onChange={handleFileInput}
          className="hidden"
          id="file-input"
        />
        <label htmlFor="file-input" className="cursor-pointer">
          {hashing ? (
            <p className="text-yellow-400">Hashing...</p>
          ) : fileName ? (
            <p className="text-gray-300">
              {fileName}{" "}
              <span className="text-gray-500 text-sm">
                (drop another to replace)
              </span>
            </p>
          ) : (
            <p className="text-gray-400">
              Drop a file here or click to select
            </p>
          )}
        </label>
      </div>
      {showUploadToggle && (
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={uploadToIpfs ?? false}
            onChange={(e) => onUploadToggle?.(e.target.checked)}
            className="rounded border-gray-600"
          />
          Upload file to IPFS (via Bulletin Chain)
          <a
            href="https://paritytech.github.io/polkadot-bulletin-chain/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-600 text-xs hover:text-gray-400 underline"
          >
            — requires authorization, expires ~7 days
          </a>
        </label>
      )}
    </div>
  );
}
