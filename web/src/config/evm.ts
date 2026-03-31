import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ETH_RPC_URL = "http://127.0.0.1:8545";

// Counter contract ABI — same for both EVM (solc) and PVM (resolc) deployments
export const counterAbi = [
  {
    type: "function",
    name: "getCounter",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setCounter",
    inputs: [{ name: "value", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "increment",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Well-known Substrate dev account Ethereum private keys
export const evmDevAccounts = [
  {
    name: "Alice",
    account: privateKeyToAccount(
      "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133"
    ),
  },
  {
    name: "Bob",
    account: privateKeyToAccount(
      "0x8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b"
    ),
  },
  {
    name: "Charlie",
    account: privateKeyToAccount(
      "0x0b6e18cafb6ed99687ec547bd28139cafbd3a4f28014f8640076aba0082bf262"
    ),
  },
];

let publicClient: ReturnType<typeof createPublicClient> | null = null;
let chainCache: Chain | null = null;

export function getPublicClient() {
  if (!publicClient) {
    publicClient = createPublicClient({
      transport: http(ETH_RPC_URL),
    });
  }
  return publicClient;
}

async function getChain(): Promise<Chain> {
  if (!chainCache) {
    const client = getPublicClient();
    const chainId = await client.getChainId();
    chainCache = defineChain({
      id: chainId,
      name: "Local Parachain",
      nativeCurrency: { name: "Unit", symbol: "UNIT", decimals: 18 },
      rpcUrls: { default: { http: [ETH_RPC_URL] } },
    });
  }
  return chainCache;
}

export async function getWalletClient(accountIndex: number) {
  const chain = await getChain();
  return createWalletClient({
    account: evmDevAccounts[accountIndex].account,
    chain,
    transport: http(ETH_RPC_URL),
  });
}
