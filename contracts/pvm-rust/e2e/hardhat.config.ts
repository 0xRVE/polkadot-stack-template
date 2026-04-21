import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const config: HardhatUserConfig = {
	solidity: "0.8.28",
	networks: {
		local: {
			url: process.env.ETH_RPC_HTTP || "http://127.0.0.1:8545",
			accounts: [
				// Alice dev account
				"0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133",
				// Bob dev account
				"0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b",
				// Charlie dev account
				"0x0b6e18cafb6ed99687ec547bd28139cafbd3a4f28014f8640076aba0082bf262",
			],
		},
	},
};

export default config;
