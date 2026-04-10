import ContractProofOfExistencePage from "../components/ContractProofOfExistencePage";
import { deployments } from "../config/deployments";

export default function EvmContractPage() {
	return (
		<ContractProofOfExistencePage
			title="EVM Proof of Existence (solc)"
			description={
				<>
					Claim file hashes via the Solidity contract compiled with{" "}
					<code className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-xs font-mono">
						solc
					</code>{" "}
					and deployed via the eth-rpc proxy. Uses{" "}
					<code className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-xs font-mono">
						viem
					</code>{" "}
					for contract interaction.
				</>
			}
			contractKind="evm"
			accentColor="purple"
			storageKey="evm-contract-address"
			defaultAddress={deployments.evm ?? undefined}
		/>
	);
}
