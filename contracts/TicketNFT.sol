// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract TicketNFT is ERC721, Ownable, ERC2771Context {
    address public immutable substrateForwarder;

    uint256 public maxSupply;
    uint256 public mintDeadline;
    bool public soulbound;
    string private _baseTokenURI;

    uint256 private _nextTokenId;
    mapping(address => bool) public hasMinted;

    error AlreadyMinted();
    error MaxSupplyReached();
    error MintDeadlinePassed();
    error SoulboundTransferBlocked();

    constructor(
        string memory eventName,
        string memory symbol,
        uint256 maxSupply_,
        uint256 mintDeadline_,
        bool soulbound_,
        string memory baseTokenURI_,
        address trustedForwarder,
        address substrateForwarder_
    )
        ERC721(eventName, symbol)
        Ownable(msg.sender)
        ERC2771Context(trustedForwarder)
    {
        substrateForwarder = substrateForwarder_;
        maxSupply = maxSupply_;
        mintDeadline = mintDeadline_;
        soulbound = soulbound_;
        _baseTokenURI = baseTokenURI_;
        _nextTokenId = 1;
    }

    function isTrustedForwarder(address forwarder) public view override returns (bool) {
        return forwarder == substrateForwarder || super.isTrustedForwarder(forwarder);
    }

    function mint() external {
        address caller = _msgSender();

        if (hasMinted[caller]) revert AlreadyMinted();
        if (_nextTokenId > maxSupply) revert MaxSupplyReached();
        if (block.timestamp > mintDeadline) revert MintDeadlinePassed();

        hasMinted[caller] = true;
        uint256 tokenId = _nextTokenId++;
        _safeMint(caller, tokenId);
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        // Allow mints (from == address(0)) and burns (to == address(0)), block transfers
        if (soulbound && from != address(0) && to != address(0)) {
            revert SoulboundTransferBlocked();
        }
        return super._update(to, tokenId, auth);
    }

    // --- Context diamond resolution ---
    // Both ERC721 and Ownable inherit from Context. ERC2771Context overrides Context.
    // Solidity requires explicit resolution.

    function _msgSender()
        internal
        view
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }
}
