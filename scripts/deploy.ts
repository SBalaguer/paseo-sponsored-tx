import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "PAS");

  // 1. Deploy ERC2771Forwarder
  console.log("\nDeploying ERC2771Forwarder...");
  const ForwarderFactory = await ethers.getContractFactory("ERC2771Forwarder");
  const forwarder = await ForwarderFactory.deploy("TicketForwarder");
  await forwarder.waitForDeployment();
  const forwarderAddress = await forwarder.getAddress();
  console.log("ERC2771Forwarder deployed to:", forwarderAddress);

  // 2. Deploy SubstrateForwarder
  console.log("\nDeploying SubstrateForwarder...");
  const SubstrateForwarderFactory = await ethers.getContractFactory("SubstrateForwarder");
  const substrateForwarder = await SubstrateForwarderFactory.deploy();
  await substrateForwarder.waitForDeployment();
  const substrateForwarderAddress = await substrateForwarder.getAddress();
  console.log("SubstrateForwarder deployed to:", substrateForwarderAddress);

  // 3. Deploy TicketNFT
  const eventName = "Polkadot Meetup 2025";
  const symbol = "PMEET";
  const maxSupply = 500;
  const mintDeadline = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90; // 90 days
  const soulbound = true;
  const baseTokenURI = "https://example.com/metadata/";

  console.log("\nDeploying TicketNFT...");
  console.log("  Event:", eventName);
  console.log("  Max supply:", maxSupply);
  console.log("  Soulbound:", soulbound);
  console.log("  Mint deadline:", new Date(mintDeadline * 1000).toISOString());

  const TicketFactory = await ethers.getContractFactory("TicketNFT");
  const ticketNFT = await TicketFactory.deploy(
    eventName,
    symbol,
    maxSupply,
    mintDeadline,
    soulbound,
    baseTokenURI,
    forwarderAddress,
    substrateForwarderAddress
  );
  await ticketNFT.waitForDeployment();
  const ticketAddress = await ticketNFT.getAddress();
  console.log("TicketNFT deployed to:", ticketAddress);

  // Summary
  console.log("\n=== Deployment Summary ===");
  console.log("FORWARDER_ADDRESS=" + forwarderAddress);
  console.log("SUBSTRATE_FORWARDER_ADDRESS=" + substrateForwarderAddress);
  console.log("TICKET_NFT_ADDRESS=" + ticketAddress);
  console.log("\nAdd these to your .env file.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
