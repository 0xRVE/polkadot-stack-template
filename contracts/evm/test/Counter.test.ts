import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEventLogs } from "viem";

describe("Counter (EVM)", function () {
  async function deployCounterFixture() {
    const [owner, otherAccount] = await hre.viem.getWalletClients();
    const counter = await hre.viem.deployContract("Counter");
    const publicClient = await hre.viem.getPublicClient();
    return { counter, owner, otherAccount, publicClient };
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

  it("Should emit CounterSet event", async function () {
    const { counter, owner, publicClient } = await loadFixture(
      deployCounterFixture
    );
    const hash = await counter.write.setCounter([42n]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: counter.abi,
      logs: receipt.logs,
      eventName: "CounterSet",
    });
    expect(logs).to.have.lengthOf(1);
    expect(getAddress(logs[0].args.who)).to.equal(
      getAddress(owner.account.address)
    );
    expect(logs[0].args.value).to.equal(42n);
  });

  it("Should emit CounterIncremented event", async function () {
    const { counter, owner, publicClient } = await loadFixture(
      deployCounterFixture
    );
    await counter.write.setCounter([5n]);
    const hash = await counter.write.increment();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({
      abi: counter.abi,
      logs: receipt.logs,
      eventName: "CounterIncremented",
    });
    expect(logs).to.have.lengthOf(1);
    expect(getAddress(logs[0].args.who)).to.equal(
      getAddress(owner.account.address)
    );
    expect(logs[0].args.newValue).to.equal(6n);
  });
});
