import ContractProofOfExistencePage from "../components/ContractProofOfExistencePage";
import { deployments } from "../config/deployments";

export default function PvmContractPage() {
	return (
		<ContractProofOfExistencePage
			title="PVM Proof of Existence (resolc)"
			description={
				<>
					Same Solidity contract compiled with{" "}
					<code className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-xs font-mono">
						resolc
					</code>{" "}
					to PolkaVM (RISC-V) bytecode, deployed via pallet-revive. Same frontend code —
					the eth-rpc proxy provides an identical interface.
				</>
			}
			contractKind="pvm"
			accentColor="green"
			storageKey="pvm-contract-address"
			defaultAddress={deployments.pvm ?? undefined}
		/>
	);
}
