// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISystem} from "./ISystem.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/**
 * @title SubstrateForwarder - sr25519 Meta-Transaction Forwarder (ERC-2771 compatible)
 * @notice Verifies sr25519 signatures via the 0x0900 precompile and forwards
 *         calls with the derived H160 address appended to calldata.
 * @dev Analogous to ERC2771Forwarder but for Substrate/sr25519 keys.
 *      After verifying the sr25519 signature against the 32-byte pubkey,
 *      the pubkey is converted to an H160 address (using the same algorithm
 *      as pallet-revive's AddressMapper) and appended to calldata as 20 bytes.
 *      Target contracts use ERC2771Context._msgSender() to read this address.
 */
contract SubstrateForwarder is Nonces {
    // ============ Constants ============

    ISystem private constant SYSTEM = ISystem(0x0000000000000000000000000000000000000900);

    /// @dev Suffix used by pallet-revive for Ethereum-derived AccountId32s.
    bytes12 private constant ETH_DERIVED_SUFFIX = bytes12(0xEEEEEEEEEEEEEEEEEEEEEEEE);

    // ============ Structs ============

    struct ForwardRequest {
        bytes32 from;        // sr25519 public key (AccountId32)
        address to;          // Target contract
        uint256 gas;         // Gas limit for the forwarded call
        uint48 deadline;     // Expiry timestamp
        bytes data;          // Encoded function call
        uint8[64] signature; // sr25519 signature
    }

    // ============ Custom Errors ============

    error SubstrateForwarderInvalidSignature();
    error SubstrateForwarderExpiredRequest(uint48 deadline);

    // ============ Events ============

    event ExecutedSubstrateRequest(bytes32 indexed from, uint256 nonce, bool success);

    // ============ Public Functions ============

    /**
     * @notice Get the nonce for a substrate public key
     * @dev Derives an address key from the pubkey to reuse OZ Nonces.
     */
    function substrateNonces(bytes32 pubkey) public view returns (uint256) {
        return nonces(_toNonceKey(pubkey));
    }

    /**
     * @notice Verify a substrate forward request without executing it
     */
    function verify(ForwardRequest calldata request) public view returns (bool) {
        if (request.deadline < block.timestamp) return false;

        bytes memory message = _buildMessage(request);
        return SYSTEM.sr25519Verify(request.signature, message, request.from);
    }

    /**
     * @notice Execute a forwarded call after verifying sr25519 signature
     * @param request The forward request including signature
     */
    function execute(ForwardRequest calldata request) public {
        // 1. Check deadline
        if (request.deadline < block.timestamp) {
            revert SubstrateForwarderExpiredRequest(request.deadline);
        }

        // 2. Build message and verify sr25519 signature
        bytes memory message = _buildMessage(request);
        bool valid = SYSTEM.sr25519Verify(request.signature, message, request.from);
        if (!valid) {
            revert SubstrateForwarderInvalidSignature();
        }

        // 3. Consume nonce (before call to prevent reentrancy replay)
        address nonceKey = _toNonceKey(request.from);
        uint256 currentNonce = _useNonce(nonceKey);

        // 4. Convert pubkey to H160 and forward call with 20-byte address
        //    appended to calldata (ERC-2771 compatible)
        uint256 reqGas = request.gas;
        address to = request.to;
        address h160 = toH160(request.from);
        bytes memory data = abi.encodePacked(request.data, h160);

        bool success;
        uint256 gasLeft;

        assembly ("memory-safe") {
            success := call(reqGas, to, 0, add(data, 0x20), mload(data), 0x00, 0x00)
            gasLeft := gas()
        }

        // 5. Gas griefing protection (same pattern as ERC2771Forwarder).
        // gasLeft must be captured immediately after CALL in the same assembly
        // block — any Solidity code in between consumes gas and creates room
        // for bypassing this check.
        _checkForwardedGas(gasLeft, reqGas);

        emit ExecutedSubstrateRequest(request.from, currentNonce, success);

        if (!success) {
            revert Errors.FailedCall();
        }
    }

    // ============ Public Pure Functions ============

    /**
     * @notice Convert a substrate AccountId32 to an H160 address.
     * @dev Replicates pallet-revive's AddressMapper::to_address():
     *      - Ethereum-derived accounts (last 12 bytes == 0xEE): first 20 bytes.
     *      - Native substrate accounts: keccak256(accountId)[12..32].
     */
    function toH160(bytes32 accountId) public pure returns (address) {
        if (bytes12(uint96(uint256(accountId))) == ETH_DERIVED_SUFFIX) {
            return address(uint160(uint256(accountId) >> 96));
        } else {
            return address(uint160(uint256(keccak256(abi.encodePacked(accountId)))));
        }
    }

    // ============ Internal Functions ============

    /**
     * @dev Build the message that the substrate user signs.
     *      Includes chainId and forwarder address for domain separation.
     *      Wrapped with <Bytes>...</Bytes> to match Polkadot wallet extension
     *      signRaw behavior (extensions wrap payloads before sr25519 signing).
     */
    function _buildMessage(ForwardRequest calldata request) internal view returns (bytes memory) {
        bytes memory inner = abi.encode(
            block.chainid,
            address(this),
            request.from,
            request.to,
            request.gas,
            substrateNonces(request.from),
            request.deadline,
            keccak256(request.data)
        );
        return abi.encodePacked("<Bytes>", inner, "</Bytes>");
    }

    /**
     * @dev Checks if the requested gas was correctly forwarded to the callee.
     *
     * As a consequence of EIP-150, at most `gasleft() - floor(gasleft() / 64)` is forwarded
     * to the callee. If the subcall ran out of gas, `gasLeft` (measured immediately after CALL)
     * equals X / 64 where X was the gas available before the CALL. Checking
     * `reqGas / 63 > gasLeft` detects when insufficient gas was forwarded.
     *
     * Uses `invalid()` to consume all remaining gas because since Solidity 0.8.20
     * neither `revert` nor `assert` consume all gas.
     */
    function _checkForwardedGas(uint256 gasLeft, uint256 reqGas) private pure {
        if (gasLeft < reqGas / 63) {
            assembly ("memory-safe") {
                invalid()
            }
        }
    }

    /**
     * @dev Convert a bytes32 pubkey to an address for use as nonce key.
     *      Uses the same derivation as toH160() so nonce keys align with
     *      the H160 addresses used for ERC-2771 forwarding.
     */
    function _toNonceKey(bytes32 pubkey) internal pure returns (address) {
        return toH160(pubkey);
    }
}
