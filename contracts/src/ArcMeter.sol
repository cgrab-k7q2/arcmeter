// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcMeter: prepaid USDC payment channels for pay-per-call APIs and AI agents on Arc.
/// @notice A payer (client or agent) locks USDC for a payee (service). For each request the payer signs
///         an off-chain EIP-712 voucher with the *cumulative* amount owed. The service verifies vouchers
///         off-chain (no gas per call) and settles any time with the latest one. The payer can reclaim the
///         unspent balance once the channel expires. One on-chain tx in, one out, any number of calls.
contract ArcMeter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Channel {
        address payer;
        address payee;
        uint128 deposit; // total USDC ever deposited
        uint128 claimed; // total USDC already paid to payee
        uint64 expiresAt; // after this, payer may reclaim the remainder
    }

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");

    IERC20 public immutable token;
    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public nonces; // per-payer counter used to derive channel ids

    event ChannelOpened(bytes32 indexed id, address indexed payer, address indexed payee, uint256 deposit, uint64 expiresAt);
    event ChannelToppedUp(bytes32 indexed id, uint256 amount, uint256 newDeposit);
    event ChannelExtended(bytes32 indexed id, uint64 expiresAt);
    event Claimed(bytes32 indexed id, address indexed payee, uint256 amount, uint256 cumulative);
    event ChannelClosed(bytes32 indexed id, uint256 paidToPayee, uint256 refundedToPayer);

    error ZeroAddress();
    error ZeroAmount();
    error BadExpiry();
    error UnknownChannel();
    error NotPayer();
    error NotPayee();
    error BadSignature();
    error ExceedsDeposit();
    error NothingToClaim();
    error NotExpired();
    error ChannelExpired();

    constructor(IERC20 token_) EIP712("ArcMeter", "1") {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    // ---------------------------------------------------------------- payer side

    function open(address payee, uint128 amount, uint64 expiresAt) external nonReentrant returns (bytes32 id) {
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert BadExpiry();
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, payee, nonces[msg.sender]++));
        channels[id] = Channel(msg.sender, payee, amount, 0, expiresAt);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ChannelOpened(id, msg.sender, payee, amount, expiresAt);
    }

    function topUp(bytes32 id, uint128 amount) external nonReentrant {
        Channel storage c = _get(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (amount == 0) revert ZeroAmount();
        c.deposit += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ChannelToppedUp(id, amount, c.deposit);
    }

    function extend(bytes32 id, uint64 expiresAt) external {
        Channel storage c = _get(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (expiresAt <= c.expiresAt) revert BadExpiry();
        c.expiresAt = expiresAt;
        emit ChannelExtended(id, expiresAt);
    }

    /// @notice After expiry the payer takes back whatever the payee has not claimed.
    ///         Payees should settle before expiry; vouchers are worthless afterwards.
    function reclaim(bytes32 id) external nonReentrant {
        Channel memory c = _get(id);
        if (msg.sender != c.payer) revert NotPayer();
        if (block.timestamp <= c.expiresAt) revert NotExpired();
        uint256 refund = c.deposit - c.claimed;
        delete channels[id];
        if (refund > 0) token.safeTransfer(c.payer, refund);
        emit ChannelClosed(id, 0, refund);
    }

    // ---------------------------------------------------------------- payee side

    /// @notice Settle up to `cumulativeAmount` signed by the payer; channel stays open.
    function claim(bytes32 id, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant returns (uint256 paid) {
        Channel storage c = _get(id);
        if (msg.sender != c.payee) revert NotPayee();
        paid = _settle(id, c, cumulativeAmount, signature);
        if (paid == 0) revert NothingToClaim();
    }

    /// @notice Settle the final voucher (optional) and refund the rest to the payer immediately.
    function close(bytes32 id, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage c = _get(id);
        if (msg.sender != c.payee) revert NotPayee();
        uint256 paid = signature.length == 0 ? 0 : _settle(id, c, cumulativeAmount, signature);
        address payer = c.payer;
        uint256 refund = c.deposit - c.claimed;
        delete channels[id];
        if (refund > 0) token.safeTransfer(payer, refund);
        emit ChannelClosed(id, paid, refund);
    }

    // ---------------------------------------------------------------- views

    function voucherDigest(bytes32 id, uint256 cumulativeAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, id, cumulativeAmount)));
    }

    /// @notice Off-chain helper for services: is this voucher currently redeemable, and for how much?
    function redeemable(bytes32 id, uint256 cumulativeAmount, bytes calldata signature) external view returns (bool ok, uint256 payable_) {
        Channel memory c = channels[id];
        if (c.payer == address(0) || block.timestamp > c.expiresAt) return (false, 0);
        if (cumulativeAmount > c.deposit || cumulativeAmount <= c.claimed) return (false, 0);
        if (!SignatureChecker.isValidSignatureNow(c.payer, voucherDigest(id, cumulativeAmount), signature)) return (false, 0);
        return (true, cumulativeAmount - c.claimed);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- internals

    function _get(bytes32 id) private view returns (Channel storage c) {
        c = channels[id];
        if (c.payer == address(0)) revert UnknownChannel();
    }

    function _settle(bytes32 id, Channel storage c, uint256 cumulativeAmount, bytes calldata signature)
        private
        returns (uint256 paid)
    {
        if (block.timestamp > c.expiresAt) revert ChannelExpired(); // expired vouchers can't be used (payer may reclaim)
        if (cumulativeAmount > c.deposit) revert ExceedsDeposit();
        if (!SignatureChecker.isValidSignatureNow(c.payer, voucherDigest(id, cumulativeAmount), signature)) {
            revert BadSignature();
        }
        if (cumulativeAmount <= c.claimed) return 0; // stale voucher: no-op
        paid = cumulativeAmount - c.claimed;
        c.claimed = uint128(cumulativeAmount);
        token.safeTransfer(c.payee, paid);
        emit Claimed(id, c.payee, paid, cumulativeAmount);
    }
}
