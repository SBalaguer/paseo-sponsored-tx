import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { TicketNFT, ERC2771Forwarder } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("TicketNFT", function () {
  let forwarder: ERC2771Forwarder;
  let ticketNFT: TicketNFT;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const EVENT_NAME = "Test Event 2025";
  const SYMBOL = "TIX";
  const MAX_SUPPLY = 100;
  const BASE_URI = "https://example.com/metadata/";
  const SOULBOUND = true;

  let mintDeadline: number;

  async function deployFixture() {
    [owner, user1, user2] = await ethers.getSigners();

    const latestTime = await time.latest();
    mintDeadline = latestTime + 60 * 60 * 24 * 30; // 30 days from now

    const ForwarderFactory = await ethers.getContractFactory("ERC2771Forwarder");
    forwarder = await ForwarderFactory.deploy("TicketForwarder");
    await forwarder.waitForDeployment();

    const TicketFactory = await ethers.getContractFactory("TicketNFT");
    ticketNFT = await TicketFactory.deploy(
      EVENT_NAME,
      SYMBOL,
      MAX_SUPPLY,
      mintDeadline,
      SOULBOUND,
      BASE_URI,
      await forwarder.getAddress()
    );
    await ticketNFT.waitForDeployment();
  }

  async function buildForwardRequest(
    signer: HardhatEthersSigner,
    forwarderContract: ERC2771Forwarder,
    targetContract: TicketNFT,
    gasLimit: number = 500000
  ) {
    const forwarderAddress = await forwarderContract.getAddress();
    const targetAddress = await targetContract.getAddress();
    const nonce = await forwarderContract.nonces(signer.address);
    const latestBlock = await time.latest();
    const deadline = latestBlock + 3600; // 1 hour from latest block

    const mintData = targetContract.interface.encodeFunctionData("mint");

    const domain = {
      name: "TicketForwarder",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: forwarderAddress,
    };

    const types = {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    };

    const message = {
      from: signer.address,
      to: targetAddress,
      value: 0n,
      gas: BigInt(gasLimit),
      nonce: nonce,
      deadline: deadline,
      data: mintData,
    };

    const signature = await signer.signTypedData(domain, types, message);

    return {
      from: signer.address,
      to: targetAddress,
      value: 0n,
      gas: BigInt(gasLimit),
      deadline: deadline,
      data: mintData,
      signature: signature,
    };
  }

  beforeEach(async function () {
    await deployFixture();
  });

  describe("Deployment", function () {
    it("should set the correct event name and symbol", async function () {
      expect(await ticketNFT.name()).to.equal(EVENT_NAME);
      expect(await ticketNFT.symbol()).to.equal(SYMBOL);
    });

    it("should set the correct parameters", async function () {
      expect(await ticketNFT.maxSupply()).to.equal(MAX_SUPPLY);
      expect(await ticketNFT.mintDeadline()).to.equal(mintDeadline);
      expect(await ticketNFT.soulbound()).to.equal(SOULBOUND);
    });

    it("should set the correct owner", async function () {
      expect(await ticketNFT.owner()).to.equal(owner.address);
    });
  });

  describe("Direct mint", function () {
    it("should mint successfully", async function () {
      await ticketNFT.connect(user1).mint();
      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
      expect(await ticketNFT.hasMinted(user1.address)).to.be.true;
      expect(await ticketNFT.totalMinted()).to.equal(1);
    });

    it("should block double mint", async function () {
      await ticketNFT.connect(user1).mint();
      await expect(ticketNFT.connect(user1).mint())
        .to.be.revertedWithCustomError(ticketNFT, "AlreadyMinted");
    });

    it("should enforce maxSupply", async function () {
      // Deploy with maxSupply = 1
      const latestTime = await time.latest();
      const TicketFactory = await ethers.getContractFactory("TicketNFT");
      const smallNFT = await TicketFactory.deploy(
        "Small Event",
        "SM",
        1, // maxSupply = 1
        latestTime + 86400,
        false,
        "",
        await forwarder.getAddress()
      );

      await smallNFT.connect(user1).mint();
      await expect(smallNFT.connect(user2).mint())
        .to.be.revertedWithCustomError(smallNFT, "MaxSupplyReached");
    });

    it("should enforce mintDeadline", async function () {
      // Advance time past deadline
      await time.increaseTo(mintDeadline + 1);
      await expect(ticketNFT.connect(user1).mint())
        .to.be.revertedWithCustomError(ticketNFT, "MintDeadlinePassed");
    });
  });

  describe("Soulbound", function () {
    it("should block transfers", async function () {
      await ticketNFT.connect(user1).mint();
      await expect(
        ticketNFT.connect(user1).transferFrom(user1.address, user2.address, 1)
      ).to.be.revertedWithCustomError(ticketNFT, "SoulboundTransferBlocked");
    });

    it("should allow minting (from zero address)", async function () {
      // If mint works, the from=zero check passes
      await ticketNFT.connect(user1).mint();
      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
    });
  });

  describe("Meta-transaction via Forwarder", function () {
    it("should mint via forwarder and resolve _msgSender() to real user", async function () {
      const request = await buildForwardRequest(user1, forwarder, ticketNFT);

      // Owner (relayer) executes the forwarded request
      await forwarder.connect(owner).execute(request);

      // NFT should be owned by user1, not owner
      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
      expect(await ticketNFT.hasMinted(user1.address)).to.be.true;
      expect(await ticketNFT.hasMinted(owner.address)).to.be.false;
    });

    it("should block double mint via forwarder", async function () {
      const request1 = await buildForwardRequest(user1, forwarder, ticketNFT);
      await forwarder.connect(owner).execute(request1);

      const request2 = await buildForwardRequest(user1, forwarder, ticketNFT);
      // The forwarder execute will revert because the inner call reverts
      await expect(forwarder.connect(owner).execute(request2))
        .to.be.reverted;
    });

    it("should allow different users to mint via forwarder", async function () {
      const req1 = await buildForwardRequest(user1, forwarder, ticketNFT);
      const req2 = await buildForwardRequest(user2, forwarder, ticketNFT);

      await forwarder.connect(owner).execute(req1);
      await forwarder.connect(owner).execute(req2);

      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
      expect(await ticketNFT.ownerOf(2)).to.equal(user2.address);
      expect(await ticketNFT.totalMinted()).to.equal(2);
    });
  });

  describe("Token URI", function () {
    it("should return correct token URI", async function () {
      await ticketNFT.connect(user1).mint();
      expect(await ticketNFT.tokenURI(1)).to.equal(BASE_URI + "1");
    });
  });
});
