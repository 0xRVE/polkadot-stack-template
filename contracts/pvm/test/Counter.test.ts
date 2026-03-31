import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";

describe("Counter (PVM)", function () {
  async function deployCounterFixture() {
    const [owner, otherAccount] = await hre.viem.getWalletClients();
    const counter = await hre.viem.deployContract("Counter");
    return { counter, owner, otherAccount };
  }

  it("Should start at zero", async function () {
    const { counter, owner } = await loadFixture(deployCounterFixture);
    expect(
      await counter.read.getCounter([owner.account.address])
    ).to.equal(0n);
  });

  it("Should set counter", async function () {
    const { counter, owner } = await loadFixture(deployCounterFixture);
    await counter.write.setCounter([42n]);
    expect(
      await counter.read.getCounter([owner.account.address])
    ).to.equal(42n);
  });

  it("Should increment counter", async function () {
    const { counter, owner } = await loadFixture(deployCounterFixture);
    await counter.write.setCounter([10n]);
    await counter.write.increment();
    expect(
      await counter.read.getCounter([owner.account.address])
    ).to.equal(11n);
  });

  it("Should track counters per account", async function () {
    const { counter, owner, otherAccount } = await loadFixture(
      deployCounterFixture
    );
    await counter.write.setCounter([100n]);
    await counter.write.setCounter([200n], {
      account: otherAccount.account,
    });
    expect(
      await counter.read.getCounter([owner.account.address])
    ).to.equal(100n);
    expect(
      await counter.read.getCounter([otherAccount.account.address])
    ).to.equal(200n);
  });
});
