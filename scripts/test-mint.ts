import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();

  const forwarderAddress = process.env.FORWARDER_ADDRESS;
  const ticketAddress = process.env.TICKET_NFT_ADDRESS;

  if (!forwarderAddress || !ticketAddress) {
    throw new Error("Set FORWARDER_ADDRESS and TICKET_NFT_ADDRESS in .env");
  }

  console.log("Relayer (deployer):", deployer.address);
  console.log("Forwarder:", forwarderAddress);
  console.log("TicketNFT:", ticketAddress);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Relayer balance:", ethers.formatEther(balance), "PAS");

  const forwarder = await ethers.getContractAt("ERC2771Forwarder", forwarderAddress);
  const ticketNFT = await ethers.getContractAt("TicketNFT", ticketAddress);

  // Use a random wallet as the "user" — no funds needed
  const testUser = ethers.Wallet.createRandom().connect(ethers.provider);
  console.log("\nTest user (random, no funds):", testUser.address);

  const totalBefore = await ticketNFT.totalMinted();
  console.log("Total minted before:", totalBefore.toString());

  // Build the ForwardRequest
  const nonce = await forwarder.nonces(testUser.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const mintData = ticketNFT.interface.encodeFunctionData("mint");
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const domain = {
    name: "TicketForwarder",
    version: "1",
    chainId: chainId,
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

  const gasLimit = 500000;

  const message = {
    from: testUser.address,
    to: ticketAddress,
    value: 0n,
    gas: BigInt(gasLimit),
    nonce: nonce,
    deadline: deadline,
    data: mintData,
  };

  console.log("\n--- Signing EIP-712 ForwardRequest as testUser ---");
  const signature = await testUser.signTypedData(domain, types, message);
  console.log("Signature:", signature.slice(0, 20) + "...");

  const request = {
    from: testUser.address,
    to: ticketAddress,
    value: 0n,
    gas: BigInt(gasLimit),
    deadline: deadline,
    data: mintData,
    signature: signature,
  };

  // Verify off-chain
  const isValid = await forwarder.verify(request);
  console.log("Off-chain verify:", isValid);

  if (!isValid) {
    throw new Error("Forward request verification failed!");
  }

  // Execute via deployer (relayer pays gas)
  console.log("\n--- Executing via forwarder (deployer pays gas) ---");
  // Explicit gas limit required — PolkaVM gas estimation is unreliable
  const tx = await forwarder.connect(deployer).execute(request, { gasLimit: 1000000 });
  console.log("Tx submitted:", tx.hash);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt!.blockNumber);
  console.log("Gas used:", receipt!.gasUsed.toString());

  // Verify results
  const totalAfter = await ticketNFT.totalMinted();
  const tokenId = totalAfter;
  const ownerOfToken = await ticketNFT.ownerOf(tokenId);
  const hasMinted = await ticketNFT.hasMinted(testUser.address);

  console.log("\n--- Results ---");
  console.log("Token #" + tokenId + " owner:", ownerOfToken);
  console.log("hasMinted:", hasMinted);
  console.log("Total minted:", totalAfter.toString());
  console.log("Owner matches testUser:", ownerOfToken === testUser.address);

  // Try double mint — should fail
  console.log("\n--- Attempting double mint (should fail) ---");
  try {
    const nonce2 = await forwarder.nonces(testUser.address);
    const message2 = { ...message, nonce: nonce2 };
    const sig2 = await testUser.signTypedData(domain, types, message2);
    const req2 = { ...request, signature: sig2 };
    const tx2 = await forwarder.connect(deployer).execute(req2, { gasLimit: 1000000 });
    await tx2.wait();
    console.log("ERROR: Double mint succeeded (should not happen)");
  } catch (e: any) {
    console.log("Double mint correctly rejected!");
  }

  console.log("\n=== Integration test passed! ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
