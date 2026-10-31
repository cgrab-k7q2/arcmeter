// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArcMeter
/// @notice Unidirectional USDC channels for pay-per-call APIs and AI agents on Arc.
/// @dev Amounts are USDC base units (6 decimals). Intended Arc USDC address:
/// 0x3600000000000000000000000000000000000000. Supply it to the constructor.
/// Uses an exact-transfer ERC-20; fee-on-transfer and rebasing tokens are unsupported.
contract ArcMeter is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The immutable settlement token.
    IERC20 public immutable usdc;

    /// @notice EIP-712 type hash for a payer's cumulative authorization.
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");

    /// @notice A channel's participants, total funding, total paid, and expiry.
    /// @dev Deposit and claimed share a slot. A zero payer denotes a missing channel.
    struct Channel {
        /// @notice Account funding and signing for this channel.
        address payer;
        /// @notice Exclusive recipient authorized to claim or close.
        address payee;
        /// @notice Total deposited base units, including top-ups.
        uint128 deposit;
        /// @notice Total base units already paid to the payee.
        uint128 claimed;
        /// @notice First timestamp at which vouchers can no longer be redeemed.
        uint64 expiresAt;
    }

    /// @notice Channel state indexed by the unique channel identifier.
    mapping(bytes32 => Channel) public channels;

    /// @notice Next channel nonce for each payer, starting at zero.
    mapping(address => uint256) public nonces;

    /// @notice Refunds that could not be sent at close and await withdrawal by the payer.
    mapping(address => uint256) public pendingRefunds;

    /// @notice A close refund failed to transfer and was credited to the payer instead.
    event RefundCredited(address indexed payer, uint256 amount);
    /// @notice A payer withdrew previously credited refunds.
    event RefundWithdrawn(address indexed payer, uint256 amount);

    /// @notice A required address was zero.
    error ZeroAddress();
    /// @notice A payer cannot open a channel to itself.
    error SelfPayment();
    /// @notice A funding amount must be positive.
    error ZeroAmount();
    /// @notice Expiry must be in the future and, when extended, strictly later.
    error InvalidExpiry();
    /// @notice The channel does not exist or has already been deleted.
    error ChannelNotFound();
    /// @notice Only the recorded payee may perform this action.
    error NotPayee();
    /// @notice Only the recorded payer may perform this action.
    error NotPayer();
    /// @notice The voucher does not authorize any additional payment.
    error NothingToClaim();
    /// @notice A cumulative authorization exceeds total channel funding.
    error ExceedsDeposit();
    /// @notice The channel has reached its expiry timestamp.
    error ChannelExpired();
    /// @notice Reclaim is unavailable before expiry.
    error ChannelNotExpired();
    /// @notice The payer did not validate the voucher signature.
    error InvalidSignature();
    /// @notice A top-up would exceed the packed deposit capacity.
    error DepositOverflow();
    /// @notice The payer's channel nonce cannot be incremented further.
    error NonceOverflow();
    /// @notice The preview signature trampoline is restricted to self-calls.
    error OnlySelf();

    /// @notice A channel was opened and funded; amounts are USDC base units.
    event ChannelOpened(
        bytes32 indexed id,
        address indexed payer,
        address indexed payee,
        uint128 amount,
        uint64 expiresAt
    );
    /// @notice A claim paid amount, bringing lifetime payments to cumulativeAmount.
    event Claimed(bytes32 indexed id, uint256 amount, uint256 cumulativeAmount);
    /// @notice A channel closed, paying an additional amount and refunding the payer.
    event Closed(bytes32 indexed id, uint256 amount, uint256 refund);
    /// @notice Funding increased by amount to the new total deposit.
    event ToppedUp(bytes32 indexed id, uint128 amount, uint128 deposit);
    /// @notice The payer changed the channel's expiry to a strictly later timestamp.
    event Extended(bytes32 indexed id, uint64 oldExpiresAt, uint64 newExpiresAt);
    /// @notice An expired channel was deleted and its remaining balance refunded.
    event Reclaimed(bytes32 indexed id, uint256 refund);

    /// @notice Initializes the immutable token and the ArcMeter version 1 signing domain.
    /// @param usdc_ USDC ERC-20 address; use Arc's 6-decimal USDC deployment.
    constructor(IERC20 usdc_) EIP712("ArcMeter", "1") {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    /// @notice Opens a funded channel to a distinct nonzero payee.
    /// @param payee Exclusive recipient of channel payments.
    /// @param amount Positive USDC base units to pull from the caller.
    /// @param expiresAt First timestamp at which vouchers expire.
    /// @return id Hash of chain ID, this contract, payer, payee, and the consumed nonce.
    function open(address payee, uint128 amount, uint64 expiresAt)
        external
        nonReentrant
        returns (bytes32 id)
    {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == msg.sender) revert SelfPayment();
        if (amount == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert InvalidExpiry();

        uint256 nonce = nonces[msg.sender];
        if (nonce == type(uint256).max) revert NonceOverflow();
        nonces[msg.sender] = nonce + 1;
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, payee, nonce));
        channels[id] = Channel(msg.sender, payee, amount, 0, expiresAt);
        emit ChannelOpened(id, msg.sender, payee, amount, expiresAt);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Computes the EIP-712 digest of a cumulative voucher, including for unknown IDs.
    /// @param channelId Channel the payer authorizes.
    /// @param cumulativeAmount Total lifetime payment authorized, in base units.
    /// @return digest Domain-separated voucher digest to sign.
    function voucherDigest(bytes32 channelId, uint256 cumulativeAmount)
        public
        view
        returns (bytes32 digest)
    {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount)));
    }

    /// @notice Pays the positive increment of a valid, unexpired cumulative voucher.
    /// @param id Existing channel identifier.
    /// @param cumulativeAmount Lifetime amount authorized by the payer.
    /// @param signature Payer EOA or ERC-1271 signature over voucherDigest.
    function claim(bytes32 id, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage channel = _channel(id);
        if (msg.sender != channel.payee) revert NotPayee();
        if (block.timestamp >= channel.expiresAt) revert ChannelExpired();
        if (cumulativeAmount <= channel.claimed) revert NothingToClaim();
        _validateVoucher(channel, id, cumulativeAmount, signature);

        uint256 amount = cumulativeAmount - channel.claimed;
        channel.claimed = uint128(cumulativeAmount);
        emit Claimed(id, amount, cumulativeAmount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Closes a channel, optionally settling a voucher, and refunds the payer.
    /// @dev Empty signatures ignore cumulativeAmount entirely and are allowed after expiry.
    /// Nonempty signatures must be valid and unexpired, even when stale; stale vouchers pay zero.
    /// The channel is deleted before any token transfer.
    /// @param id Existing channel identifier.
    /// @param cumulativeAmount Authorized lifetime amount; ignored with an empty signature.
    /// @param signature Optional payer signature; empty means no additional settlement.
    function close(bytes32 id, uint256 cumulativeAmount, bytes calldata signature) external nonReentrant {
        Channel storage stored = _channel(id);
        if (msg.sender != stored.payee) revert NotPayee();
        uint256 amount = 0;
        if (signature.length != 0) {
            _validateVoucher(stored, id, cumulativeAmount, signature);
            if (cumulativeAmount > stored.claimed) amount = cumulativeAmount - stored.claimed;
        }

        Channel memory channel = stored;
        uint256 refund = uint256(channel.deposit) - channel.claimed - amount;
        delete channels[id];
        emit Closed(id, amount, refund);
        if (amount != 0) usdc.safeTransfer(channel.payee, amount);
        if (refund != 0) _refundOrCredit(channel.payer, refund);
    }

    /// @notice Withdraws a refund that could not be delivered when its channel was closed.
    /// @dev Callable only for the caller's own credit; reverts if the token still rejects the payer.
    function withdrawRefund() external nonReentrant {
        uint256 amount = pendingRefunds[msg.sender];
        if (amount == 0) revert ZeroAmount();
        pendingRefunds[msg.sender] = 0;
        emit RefundWithdrawn(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Adds funding to an existing, unexpired channel, without changing prior payments.
    /// @param id Channel owned by the caller.
    /// @param amount Positive additional USDC base units to pull from the payer.
    function topUp(bytes32 id, uint128 amount) external nonReentrant {
        Channel storage channel = _channel(id);
        if (msg.sender != channel.payer) revert NotPayer();
        if (block.timestamp >= channel.expiresAt) revert ChannelExpired();
        if (amount == 0) revert ZeroAmount();
        uint256 deposit = uint256(channel.deposit) + amount;
        if (deposit > type(uint128).max) revert DepositOverflow();
        channel.deposit = uint128(deposit);
        emit ToppedUp(id, amount, channel.deposit);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Extends a channel to a strictly later, future expiry.
    /// @dev The payer may also revive an expired but unreclaimed channel. Prior vouchers
    /// remain usable because vouchers bind to the channel, not to a particular expiry.
    /// @param id Channel owned by the caller.
    /// @param newExpiresAt New expiry, strictly greater than both the old expiry and now.
    function extend(bytes32 id, uint64 newExpiresAt) external nonReentrant {
        Channel storage channel = _channel(id);
        if (msg.sender != channel.payer) revert NotPayer();
        if (newExpiresAt <= channel.expiresAt || newExpiresAt <= block.timestamp) revert InvalidExpiry();
        uint64 oldExpiresAt = channel.expiresAt;
        channel.expiresAt = newExpiresAt;
        emit Extended(id, oldExpiresAt, newExpiresAt);
    }

    /// @notice Deletes an expired channel and refunds all unpaid funding to its payer.
    /// @param id Expired channel owned by the caller.
    function reclaim(bytes32 id) external nonReentrant {
        Channel storage stored = _channel(id);
        if (msg.sender != stored.payer) revert NotPayer();
        if (block.timestamp < stored.expiresAt) revert ChannelNotExpired();
        uint256 refund = uint256(stored.deposit) - stored.claimed;
        address payer = stored.payer;
        delete channels[id];
        emit Reclaimed(id, refund);
        if (refund != 0) usdc.safeTransfer(payer, refund);
    }

    /// @notice Non-reverting preview of whether the payee could claim this voucher now.
    /// @dev Caller-independent, so servers can check vouchers from any address (the payee
    /// restriction is enforced by claim itself). Signature validation runs in a caught,
    /// gas-limited self-call so reverting or gas-burning ERC-1271 wallets yield (false, 0).
    /// Like any EVM view, execution requires sufficient gas for calldata and local work;
    /// a preview cannot guarantee a later transaction or an external token transfer succeeds.
    /// @param id Channel to preview.
    /// @param cumulativeAmount Proposed lifetime payment authorization.
    /// @param signature Payer EOA or ERC-1271 signature.
    /// @return ok True if the channel, amount, and signature permit a claim now.
    /// @return amount Incremental USDC base units payable, or zero when not redeemable.
    function redeemable(bytes32 id, uint256 cumulativeAmount, bytes calldata signature)
        external
        view
        returns (bool ok, uint256 amount)
    {
        Channel storage channel = channels[id];
        if (
            channel.payer == address(0) || block.timestamp >= channel.expiresAt
                || cumulativeAmount <= channel.claimed
                || cumulativeAmount > channel.deposit
        ) return (false, 0);

        bytes32 digest = voucherDigest(id, cumulativeAmount);
        try this.checkVoucherSignature{gas: gasleft() / 2}(channel.payer, digest, signature)
            returns (bool valid)
        {
            if (valid) return (true, cumulativeAmount - channel.claimed);
        } catch {}
        return (false, 0);
    }

    /// @notice Isolates signature verification so redeemable can catch wallet failures.
    /// @dev Only callable by this contract; not an independent public verification endpoint.
    /// @param payer Account that must validate the signature.
    /// @param digest EIP-712 digest to validate.
    /// @param signature EOA or ERC-1271 signature data.
    /// @return valid Whether OpenZeppelin SignatureChecker accepts the signature now.
    function checkVoucherSignature(address payer, bytes32 digest, bytes calldata signature)
        external
        view
        returns (bool valid)
    {
        if (msg.sender != address(this)) revert OnlySelf();
        return SignatureChecker.isValidSignatureNow(payer, digest, signature);
    }

    /// @notice Sends a payer refund, or records it as a withdrawable credit if the token rejects it.
    /// @dev Keeps a payer that cannot receive USDC (for example blocklisted) from blocking the
    /// payee's close. The channel is already deleted when this runs.
    /// @param payer Refund recipient.
    /// @param amount Refund in base units.
    function _refundOrCredit(address payer, uint256 amount) private {
        try usdc.transfer(payer, amount) returns (bool ok) {
            if (ok) return;
        } catch {}
        pendingRefunds[payer] += amount;
        emit RefundCredited(payer, amount);
    }

    /// @notice Loads an existing channel or reverts with ChannelNotFound.
    /// @param id Channel identifier to look up.
    /// @return channel Storage reference to the existing channel.
    function _channel(bytes32 id) private view returns (Channel storage channel) {
        channel = channels[id];
        if (channel.payer == address(0)) revert ChannelNotFound();
    }

    /// @notice Checks the expiry, deposit bound, and payer signature of a voucher.
    /// @dev Deliberately does not reject stale vouchers; close accepts them without payment.
    /// @param channel Existing channel whose payer must authorize the voucher.
    /// @param id Channel identifier embedded in the signed voucher.
    /// @param cumulativeAmount Authorized lifetime payment amount.
    /// @param signature Payer EOA or ERC-1271 signature data.
    function _validateVoucher(
        Channel storage channel,
        bytes32 id,
        uint256 cumulativeAmount,
        bytes calldata signature
    ) private view {
        if (block.timestamp >= channel.expiresAt) revert ChannelExpired();
        if (cumulativeAmount > channel.deposit) revert ExceedsDeposit();
        if (!SignatureChecker.isValidSignatureNow(channel.payer, voucherDigest(id, cumulativeAmount), signature)) {
            revert InvalidSignature();
        }
    }
}
