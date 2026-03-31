import hre from "hardhat";

async function main() {
  console.log("Deploying Counter (PVM/resolc)...");
  const counter = await hre.viem.deployContract("Counter");
  console.log(`PVM Counter deployed to: ${counter.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
