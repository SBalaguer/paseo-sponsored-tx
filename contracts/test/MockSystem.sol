// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Mock of the 0x0900 system precompile for testing sr25519Verify
contract MockSystem {
    bool public shouldVerify = true;

    function setShouldVerify(bool _v) external {
        shouldVerify = _v;
    }

    function sr25519Verify(uint8[64] calldata, bytes calldata, bytes32) external view returns (bool) {
        return shouldVerify;
    }

    function toAccountId(address) external pure returns (bytes memory) {
        return new bytes(32);
    }
}
