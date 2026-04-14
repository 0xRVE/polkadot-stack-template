// Asset-conversion precompile ABI — matches IAssetConversion from the precompile.
// The precompile lives at a fixed address derived from ADDRESS=0x0420.
export const ASSET_CONVERSION_PRECOMPILE_ADDRESS =
	"0x0000000000000000000000000000000004200000" as const;

export const assetConversionAbi = [
	{
		type: "function",
		name: "swapExactTokensForTokens",
		inputs: [
			{ name: "path", type: "bytes[]" },
			{ name: "amountIn", type: "uint256" },
			{ name: "amountOutMin", type: "uint256" },
			{ name: "sendTo", type: "address" },
			{ name: "keepAlive", type: "bool" },
		],
		outputs: [{ name: "amountOut", type: "uint256" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "swapTokensForExactTokens",
		inputs: [
			{ name: "path", type: "bytes[]" },
			{ name: "amountOut", type: "uint256" },
			{ name: "amountInMax", type: "uint256" },
			{ name: "sendTo", type: "address" },
			{ name: "keepAlive", type: "bool" },
		],
		outputs: [{ name: "amountIn", type: "uint256" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "quoteExactTokensForTokens",
		inputs: [
			{ name: "asset1", type: "bytes" },
			{ name: "asset2", type: "bytes" },
			{ name: "amount", type: "uint256" },
			{ name: "includeFee", type: "bool" },
		],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "quoteTokensForExactTokens",
		inputs: [
			{ name: "asset1", type: "bytes" },
			{ name: "asset2", type: "bytes" },
			{ name: "amount", type: "uint256" },
			{ name: "includeFee", type: "bool" },
		],
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
	},
	{
		type: "function",
		name: "createPool",
		inputs: [
			{ name: "asset1", type: "bytes" },
			{ name: "asset2", type: "bytes" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "addLiquidity",
		inputs: [
			{ name: "asset1", type: "bytes" },
			{ name: "asset2", type: "bytes" },
			{ name: "amount1Desired", type: "uint256" },
			{ name: "amount2Desired", type: "uint256" },
			{ name: "amount1Min", type: "uint256" },
			{ name: "amount2Min", type: "uint256" },
			{ name: "mintTo", type: "address" },
		],
		outputs: [{ name: "lpTokensMinted", type: "uint256" }],
		stateMutability: "nonpayable",
	},
	{
		type: "function",
		name: "removeLiquidity",
		inputs: [
			{ name: "asset1", type: "bytes" },
			{ name: "asset2", type: "bytes" },
			{ name: "lpTokenBurn", type: "uint256" },
			{ name: "amount1MinReceive", type: "uint256" },
			{ name: "amount2MinReceive", type: "uint256" },
			{ name: "withdrawTo", type: "address" },
		],
		outputs: [
			{ name: "amount1", type: "uint256" },
			{ name: "amount2", type: "uint256" },
		],
		stateMutability: "nonpayable",
	},
] as const;

// SCALE-encoded NativeOrWithId variants for the two test assets + native.
// NativeOrWithId::Native = enum variant 0 = 0x00
// NativeOrWithId::WithId(1) = enum variant 1, little-endian u32 = 0x01 01000000
// NativeOrWithId::WithId(2) = enum variant 1, little-endian u32 = 0x01 02000000
export const ASSETS = {
	native: { label: "Native", encoded: "0x00" as const },
	testA: { label: "TSTA (id=1)", encoded: "0x0101000000" as const },
	testB: { label: "TSTB (id=2)", encoded: "0x0102000000" as const },
} as const;
