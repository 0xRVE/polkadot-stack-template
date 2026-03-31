import ContractCounterPage from "../components/ContractCounterPage";

export default function EvmContractPage() {
  return (
    <ContractCounterPage
      title="EVM Counter (solc)"
      description={
        <>
          Interact with the Solidity counter compiled with{" "}
          <code className="bg-gray-800 px-1 rounded">solc</code> and deployed
          via the eth-rpc proxy. Uses{" "}
          <code className="bg-gray-800 px-1 rounded">viem</code> for contract
          reads and writes.
        </>
      }
      accentColor="purple"
      storageKey="evm-contract-address"
    />
  );
}
