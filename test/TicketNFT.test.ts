import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { TicketNFT, ERC2771Forwarder, SubstrateForwarder } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const SYSTEM_PRECOMPILE = "0x0000000000000000000000000000000000000900";

describe("TicketNFT", function () {
  let forwarder: ERC2771Forwarder;
  let substrateForwarder: SubstrateForwarder;
  let ticketNFT: TicketNFT;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const EVENT_NAME = "Test Event 2025";
  const SYMBOL = "TIX";
  const MAX_SUPPLY = 100;
  const BASE_URI = "https://example.com/metadata/";
  const SOULBOUND = true;

  const TEST_PUBKEY = ethers.keccak256(ethers.toUtf8Bytes("test-substrate-key"));
  const TEST_PUBKEY_2 = ethers.keccak256(ethers.toUtf8Bytes("test-substrate-key-2"));

  let mintDeadline: number;

  function testSignature(): number[] {
    const sig: number[] = [];
    for (let i = 0; i < 64; i++) {
      sig.push(i);
    }
    return sig;
  }

  function h160(pubkey: string): string {
    // Replicates SubstrateForwarder.toH160() for native substrate keys
    const hash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [pubkey]));
    return "0x" + hash.slice(26);
  }

  async function setupMockSystem(shouldVerify: boolean = true) {
    // Deploy MockSystem to get its bytecode
    const MockSystemFactory = await ethers.getContractFactory("MockSystem");
    const mockSystem = await MockSystemFactory.deploy();
    await mockSystem.waitForDeployment();

    // Get the deployed bytecode
    const deployedCode = await ethers.provider.getCode(await mockSystem.getAddress());

    // Set the code at the precompile address
    await network.provider.send("hardhat_setCode", [SYSTEM_PRECOMPILE, deployedCode]);

    // Set shouldVerify storage (slot 0)
    await network.provider.send("hardhat_setStorageAt", [
      SYSTEM_PRECOMPILE,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      shouldVerify
        ? "0x0000000000000000000000000000000000000000000000000000000000000001"
        : "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]);
  }

  async function setMockVerify(value: boolean) {
    await network.provider.send("hardhat_setStorageAt", [
      SYSTEM_PRECOMPILE,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      value
        ? "0x0000000000000000000000000000000000000000000000000000000000000001"
        : "0x0000000000000000000000000000000000000000000000000000000000000000",
    ]);
  }

  async function deployFixture() {
    [owner, user1, user2] = await ethers.getSigners();

    const latestTime = await time.latest();
    mintDeadline = latestTime + 60 * 60 * 24 * 30; // 30 days from now

    // Setup mock precompile
    await setupMockSystem(true);

    const ForwarderFactory = await ethers.getContractFactory("ERC2771Forwarder");
    forwarder = await ForwarderFactory.deploy("TicketForwarder");
    await forwarder.waitForDeployment();

    const SubstrateForwarderFactory = await ethers.getContractFactory("SubstrateForwarder");
    substrateForwarder = await SubstrateForwarderFactory.deploy();
    await substrateForwarder.waitForDeployment();

    const TicketFactory = await ethers.getContractFactory("TicketNFT");
    ticketNFT = await TicketFactory.deploy(
      EVENT_NAME,
      SYMBOL,
      MAX_SUPPLY,
      mintDeadline,
      SOULBOUND,
      BASE_URI,
      await forwarder.getAddress(),
      await substrateForwarder.getAddress()
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

  async function buildSubstrateRequest(
    pubkey: string,
    deadline: number,
    gasLimit: number = 500000
  ) {
    const targetAddress = await ticketNFT.getAddress();
    const mintData = ticketNFT.interface.encodeFunctionData("mint");

    return {
      from: pubkey,
      to: targetAddress,
      gas: BigInt(gasLimit),
      deadline: deadline,
      data: mintData,
      signature: testSignature(),
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

    it("should trust both forwarders", async function () {
      expect(await ticketNFT.isTrustedForwarder(await forwarder.getAddress())).to.be.true;
      expect(await ticketNFT.isTrustedForwarder(await substrateForwarder.getAddress())).to.be.true;
      expect(await ticketNFT.isTrustedForwarder(user1.address)).to.be.false;
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
      const latestTime = await time.latest();
      const TicketFactory = await ethers.getContractFactory("TicketNFT");
      const smallNFT = await TicketFactory.deploy(
        "Small Event",
        "SM",
        1, // maxSupply = 1
        latestTime + 86400,
        false,
        "",
        await forwarder.getAddress(),
        await substrateForwarder.getAddress()
      );

      await smallNFT.connect(user1).mint();
      await expect(smallNFT.connect(user2).mint())
        .to.be.revertedWithCustomError(smallNFT, "MaxSupplyReached");
    });

    it("should enforce mintDeadline", async function () {
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
      await ticketNFT.connect(user1).mint();
      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
    });
  });

  describe("Meta-transaction via ERC2771Forwarder", function () {
    it("should mint via forwarder and resolve _msgSender() to real user", async function () {
      const request = await buildForwardRequest(user1, forwarder, ticketNFT);

      await forwarder.connect(owner).execute(request);

      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
      expect(await ticketNFT.hasMinted(user1.address)).to.be.true;
      expect(await ticketNFT.hasMinted(owner.address)).to.be.false;
    });

    it("should block double mint via forwarder", async function () {
      const request1 = await buildForwardRequest(user1, forwarder, ticketNFT);
      await forwarder.connect(owner).execute(request1);

      const request2 = await buildForwardRequest(user1, forwarder, ticketNFT);
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

  describe("SubstrateForwarder: toH160 Conversion", function () {
    it("should convert native substrate pubkey via keccak256", async function () {
      const expected = ethers.getAddress(h160(TEST_PUBKEY));
      const result = await substrateForwarder.toH160(TEST_PUBKEY);
      expect(result).to.equal(expected);
    });

    it("should extract H160 from eth-derived AccountId32", async function () {
      const original = "0x1234567890AbcdEF1234567890aBcdef12345678";
      // Eth-derived: first 20 bytes are H160, last 12 are 0xEE
      const ethDerived = ethers.solidityPacked(
        ["address", "bytes12"],
        [original, "0xEEEEEEEEEEEEEEEEEEEEEEEE"]
      );
      const result = await substrateForwarder.toH160(ethDerived);
      expect(result).to.equal(ethers.getAddress(original));
    });
  });

  describe("SubstrateForwarder: Meta-transaction", function () {
    it("should execute via SubstrateForwarder and mint NFT to H160", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      await substrateForwarder.connect(owner).execute(req);

      const expectedH160 = ethers.getAddress(h160(TEST_PUBKEY));
      expect(await ticketNFT.ownerOf(1)).to.equal(expectedH160);
      expect(await ticketNFT.hasMinted(expectedH160)).to.be.true;
      expect(await ticketNFT.totalMinted()).to.equal(1);
    });

    it("should start nonce at 0", async function () {
      expect(await substrateForwarder.substrateNonces(TEST_PUBKEY)).to.equal(0);
    });

    it("should increment nonce after execution", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      await substrateForwarder.connect(owner).execute(req);

      expect(await substrateForwarder.substrateNonces(TEST_PUBKEY)).to.equal(1);
    });

    it("should have independent nonces per pubkey", async function () {
      const latestBlock = await time.latest();
      const req1 = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(req1);

      const req2 = await buildSubstrateRequest(TEST_PUBKEY_2, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(req2);

      expect(await substrateForwarder.substrateNonces(TEST_PUBKEY)).to.equal(1);
      expect(await substrateForwarder.substrateNonces(TEST_PUBKEY_2)).to.equal(1);
    });

    it("should revert on expired deadline", async function () {
      const latestBlock = await time.latest();
      const pastDeadline = latestBlock - 1;
      const req = await buildSubstrateRequest(TEST_PUBKEY, pastDeadline);

      await expect(substrateForwarder.connect(owner).execute(req))
        .to.be.revertedWithCustomError(substrateForwarder, "SubstrateForwarderExpiredRequest")
        .withArgs(pastDeadline);
    });

    it("should revert on invalid signature", async function () {
      await setMockVerify(false);

      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      await expect(substrateForwarder.connect(owner).execute(req))
        .to.be.revertedWithCustomError(substrateForwarder, "SubstrateForwarderInvalidSignature");
    });

    it("should prevent replay", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      await substrateForwarder.connect(owner).execute(req);

      // Second execution should fail (nonce changed + AlreadyMinted)
      await expect(substrateForwarder.connect(owner).execute(req))
        .to.be.reverted;
    });

    it("should verify valid request", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      expect(await substrateForwarder.verify(req)).to.be.true;
    });

    it("should reject expired request in verify", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock - 1);

      expect(await substrateForwarder.verify(req)).to.be.false;
    });

    it("should reject invalid signature in verify", async function () {
      await setMockVerify(false);

      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      expect(await substrateForwarder.verify(req)).to.be.false;
    });

    it("should allow anyone to call execute", async function () {
      const latestBlock = await time.latest();
      const req = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);

      // user2 (not owner/relayer) can execute
      await substrateForwarder.connect(user2).execute(req);

      const expectedH160 = ethers.getAddress(h160(TEST_PUBKEY));
      expect(await ticketNFT.ownerOf(1)).to.equal(expectedH160);
    });

    it("should allow multiple substrate users to claim independently", async function () {
      const latestBlock = await time.latest();

      const req1 = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(req1);

      const req2 = await buildSubstrateRequest(TEST_PUBKEY_2, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(req2);

      const h160_1 = ethers.getAddress(h160(TEST_PUBKEY));
      const h160_2 = ethers.getAddress(h160(TEST_PUBKEY_2));

      expect(await ticketNFT.ownerOf(1)).to.equal(h160_1);
      expect(await ticketNFT.ownerOf(2)).to.equal(h160_2);
      expect(await ticketNFT.totalMinted()).to.equal(2);
    });
  });

  describe("Cross-forwarder", function () {
    it("should allow ECDSA user and Substrate user to both mint", async function () {
      // ECDSA user mints via ERC2771Forwarder
      const ecdsaReq = await buildForwardRequest(user1, forwarder, ticketNFT);
      await forwarder.connect(owner).execute(ecdsaReq);

      // Substrate user mints via SubstrateForwarder
      const latestBlock = await time.latest();
      const subReq = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(subReq);

      expect(await ticketNFT.ownerOf(1)).to.equal(user1.address);
      const expectedH160 = ethers.getAddress(h160(TEST_PUBKEY));
      expect(await ticketNFT.ownerOf(2)).to.equal(expectedH160);
      expect(await ticketNFT.totalMinted()).to.equal(2);
    });

    it("should prevent double-claim when same H160 already minted via substrate", async function () {
      // Mint via SubstrateForwarder
      const latestBlock = await time.latest();
      const subReq = await buildSubstrateRequest(TEST_PUBKEY, latestBlock + 3600);
      await substrateForwarder.connect(owner).execute(subReq);

      // Try to mint directly from the same H160 — should fail
      const derivedH160 = ethers.getAddress(h160(TEST_PUBKEY));
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [derivedH160],
      });
      // Fund the impersonated account for gas
      await owner.sendTransaction({ to: derivedH160, value: ethers.parseEther("1") });

      const impersonatedSigner = await ethers.getSigner(derivedH160);
      await expect(ticketNFT.connect(impersonatedSigner).mint())
        .to.be.revertedWithCustomError(ticketNFT, "AlreadyMinted");

      await network.provider.request({
        method: "hardhat_stopImpersonatingAccount",
        params: [derivedH160],
      });
    });
  });

  describe("Token URI", function () {
    it("should return correct token URI", async function () {
      await ticketNFT.connect(user1).mint();
      expect(await ticketNFT.tokenURI(1)).to.equal(BASE_URI + "1");
    });
  });
});
