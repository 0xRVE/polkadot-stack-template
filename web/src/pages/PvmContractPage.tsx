import ContractCounterPage from "../components/ContractCounterPage";

export default function PvmContractPage() {
  return (
    <ContractCounterPage
      title="PVM Counter (resolc)"
      description={
        <>
          Interact with the same Solidity counter compiled with{" "}
          <code className="bg-gray-800 px-1 rounded">resolc</code> to PolkaVM
          (RISC-V) bytecode, deployed via pallet-revive. Same frontend code —
          the eth-rpc proxy provides an identical interface.
        </>
      }
      accentColor="green"
      storageKey="pvm-contract-address"
    />
  );
}
