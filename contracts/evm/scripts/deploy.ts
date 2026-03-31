import hre from "hardhat";

async function main() {
  console.log("Deploying Counter (EVM/solc)...");
  const counter = await hre.viem.deployContract("Counter");
  console.log(`EVM Counter deployed to: ${counter.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
