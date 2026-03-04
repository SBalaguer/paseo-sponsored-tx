// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISystem - Polkadot Asset Hub System Precompile Interface
 * @notice Subset of the system precompile at 0x0000000000000000000000000000000000000900
 * @dev Only sr25519Verify and toAccountId are included. Extend as needed.
 */
interface ISystem {
    /// @notice Verify an sr25519 signature
    /// @param signature 64-byte sr25519 signature
    /// @param message Arbitrary message bytes that were signed
    /// @param publicKey 32-byte sr25519 public key
    /// @return True if the signature is valid
    function sr25519Verify(
        uint8[64] calldata signature,
        bytes calldata message,
        bytes32 publicKey
    ) external view returns (bool);

    /// @notice Convert an H160 address to its AccountId32 representation
    /// @param input The EVM address
    /// @return account_id The 32-byte Substrate account ID
    function toAccountId(address input) external view returns (bytes memory account_id);
}
