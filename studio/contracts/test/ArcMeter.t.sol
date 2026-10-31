// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ArcMeter} from "../ArcMeter.sol";

/// @dev 6-decimal mock USDC with a recipient blocklist (like real USDC) and an optional
/// soft-fail mode where `transfer` to a blocked recipient returns false instead of reverting.
contract MockUSDC6 is ERC20 {
    error Blocked(address account);

    mapping(address => bool) public blocked;
    bool public softFail;

    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool v) external {
        blocked[account] = v;
    }

    function setSoftFail(bool v) external {
        softFail = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (softFail && blocked[to]) return false;
        return super.transfer(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[to] || blocked[from]) revert Blocked(blocked[to] ? to : from);
        super._update(from, to, value);
    }
}

/// @dev Minimal ERC-1271 smart-contract wallet; `signer` EOA signs on its behalf.
contract MockWallet1271 {
    address public immutable signer;
    bool public shouldRevert;

    constructor(address signer_) {
        signer = signer_;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        if (shouldRevert) revert("wallet-revert");
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        if (err == ECDSA.RecoverError.NoError && rec == signer) return 0x1626ba7e;
        return 0xffffffff;
    }

    function approveAndOpen(IERC20 token, ArcMeter meter, address payee, uint128 amount, uint64 expiresAt)
        external
        returns (bytes32)
    {
        token.approve(address(meter), amount);
        return meter.open(payee, amount, expiresAt);
    }
}

contract ArcMeterTest is Test {
    ArcMeter internal meter;
    MockUSDC6 internal usdc;

    address internal payer;
    uint256 internal payerPk;
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");
    address internal foreign;
    uint256 internal foreignPk;

    uint256 internal constant T0 = 1_000_000;
    uint128 internal constant DEP = 1_000e6;
    uint64 internal expiry;

    // fuzz scratch (kept in storage to avoid stack-too-deep)
    uint256 internal payerBefore;
    uint256 internal payeeBefore;

    event ChannelOpened(
        bytes32 indexed id, address indexed payer, address indexed payee, uint128 amount, uint64 expiresAt
    );
    event Claimed(bytes32 indexed id, uint256 amount, uint256 cumulativeAmount);
    event Closed(bytes32 indexed id, uint256 amount, uint256 refund);
    event ToppedUp(bytes32 indexed id, uint128 amount, uint128 deposit);
    event Extended(bytes32 indexed id, uint64 oldExpiresAt, uint64 newExpiresAt);
    event Reclaimed(bytes32 indexed id, uint256 refund);
    event RefundCredited(address indexed payer, uint256 amount);
    event RefundWithdrawn(address indexed payer, uint256 amount);

    function setUp() public {
        vm.warp(T0);
        expiry = uint64(T0 + 1 days);
        (payer, payerPk) = makeAddrAndKey("payer");
        (foreign, foreignPk) = makeAddrAndKey("foreign");
        usdc = new MockUSDC6();
        meter = new ArcMeter(IERC20(address(usdc)));
        usdc.mint(payer, 1e30);
        vm.prank(payer);
        usdc.approve(address(meter), type(uint256).max);
    }

    // ------------------------------------------------------------ helpers

    function _open(uint128 amount) internal returns (bytes32 id) {
        vm.prank(payer);
        id = meter.open(payee, amount, expiry);
    }

    function _sig(uint256 pk, bytes32 id, uint256 amt) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, meter.voucherDigest(id, amt));
        return abi.encodePacked(r, s, v);
    }

    function _claim(bytes32 id, uint256 amt) internal {
        bytes memory sig = _sig(payerPk, id, amt);
        vm.prank(payee);
        meter.claim(id, amt, sig);
    }

    function _claimed(bytes32 id) internal view returns (uint128 c) {
        (,,, c,) = meter.channels(id);
    }

    function _deposit(bytes32 id) internal view returns (uint128 d) {
        (,, d,,) = meter.channels(id);
    }

    function _exists(bytes32 id) internal view returns (bool) {
        (address p,,,,) = meter.channels(id);
        return p != address(0);
    }

    // ------------------------------------------------------------ constructor

    function test_Constructor_StoresUsdc() public view {
        assertEq(address(meter.usdc()), address(usdc));
    }

    function test_Constructor_RevertsOnZeroToken() public {
        vm.expectRevert(ArcMeter.ZeroAddress.selector);
        new ArcMeter(IERC20(address(0)));
    }

    // ------------------------------------------------------------ open

    function test_Open_StoresChannelAndPullsFunds() public {
        bytes32 id = _open(DEP);
        (address p, address q, uint128 d, uint128 c, uint64 e) = meter.channels(id);
        assertEq(p, payer);
        assertEq(q, payee);
        assertEq(d, DEP);
        assertEq(c, 0);
        assertEq(e, expiry);
        assertEq(usdc.balanceOf(address(meter)), DEP);
    }

    function test_Open_DeterministicId() public {
        bytes32 expected = keccak256(abi.encode(block.chainid, address(meter), payer, payee, uint256(0)));
        assertEq(_open(DEP), expected);
        bytes32 expected2 = keccak256(abi.encode(block.chainid, address(meter), payer, payee, uint256(1)));
        assertEq(_open(DEP), expected2);
    }

    function test_Open_NonceIncrementsAndIdenticalOpensDiffer() public {
        assertEq(meter.nonces(payer), 0);
        bytes32 a = _open(DEP);
        assertEq(meter.nonces(payer), 1);
        bytes32 b = _open(DEP);
        assertEq(meter.nonces(payer), 2);
        assertTrue(a != b);
        assertTrue(_exists(a) && _exists(b));
    }

    function test_Open_EmitsChannelOpened() public {
        bytes32 id = keccak256(abi.encode(block.chainid, address(meter), payer, payee, uint256(0)));
        vm.expectEmit(true, true, true, true, address(meter));
        emit ChannelOpened(id, payer, payee, DEP, expiry);
        _open(DEP);
    }

    function test_Open_RevertsZeroPayee() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ZeroAddress.selector);
        meter.open(address(0), DEP, expiry);
    }

    function test_Open_RevertsSelfPayee() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.SelfPayment.selector);
        meter.open(payer, DEP, expiry);
    }

    function test_Open_RevertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.open(payee, 0, expiry);
    }

    function test_Open_RevertsExpiryNowOrPast() public {
        vm.startPrank(payer);
        vm.expectRevert(ArcMeter.InvalidExpiry.selector);
        meter.open(payee, DEP, uint64(block.timestamp));
        vm.expectRevert(ArcMeter.InvalidExpiry.selector);
        meter.open(payee, DEP, uint64(block.timestamp - 1));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ voucherDigest

    function test_VoucherDigest_MatchesManualEip712() public view {
        bytes32 id = keccak256("some-channel");
        uint256 amt = 123e6;
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ArcMeter")),
                keccak256(bytes("1")),
                block.chainid,
                address(meter)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)"), id, amt)
        );
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        assertEq(meter.voucherDigest(id, amt), expected);
        assertEq(meter.VOUCHER_TYPEHASH(), keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)"));
    }

    function testFuzz_VoucherDigest_MatchesManual(bytes32 id, uint256 amt) public view {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ArcMeter")),
                keccak256(bytes("1")),
                block.chainid,
                address(meter)
            )
        );
        bytes32 structHash = keccak256(abi.encode(meter.VOUCHER_TYPEHASH(), id, amt));
        assertEq(meter.voucherDigest(id, amt), keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
    }

    // ------------------------------------------------------------ claim

    function test_Claim_IncrementalPaysOnlyDelta() public {
        bytes32 id = _open(DEP);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Claimed(id, 100e6, 100e6);
        _claim(id, 100e6);
        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(_claimed(id), 100e6);
        assertTrue(_exists(id), "channel stays open");

        vm.expectEmit(true, false, false, true, address(meter));
        emit Claimed(id, 150e6, 250e6);
        _claim(id, 250e6);
        assertEq(usdc.balanceOf(payee), 250e6);
        assertEq(_claimed(id), 250e6);
        assertTrue(_exists(id));
        assertEq(usdc.balanceOf(address(meter)), DEP - 250e6);
    }

    function test_Claim_UpToFullDeposit() public {
        bytes32 id = _open(DEP);
        _claim(id, DEP);
        assertEq(usdc.balanceOf(payee), DEP);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }

    function test_Claim_ReplayReverts() public {
        bytes32 id = _open(DEP);
        _claim(id, 100e6);
        bytes memory sig = _sig(payerPk, id, 100e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NothingToClaim.selector);
        meter.claim(id, 100e6, sig);
    }

    function test_Claim_StaleLowerVoucherReverts() public {
        bytes32 id = _open(DEP);
        _claim(id, 100e6);
        bytes memory sig = _sig(payerPk, id, 40e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NothingToClaim.selector);
        meter.claim(id, 40e6, sig);
    }

    function test_Claim_ZeroAmountReverts() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 0);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NothingToClaim.selector);
        meter.claim(id, 0, sig);
    }

    function test_Claim_ExceedsDeposit() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, uint256(DEP) + 1);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ExceedsDeposit.selector);
        meter.claim(id, uint256(DEP) + 1, sig);
    }

    function test_Claim_ForeignSignerReverts() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(foreignPk, id, 10e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.claim(id, 10e6, sig);
    }

    function test_Claim_AmountNotMatchingSignatureReverts() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.claim(id, 11e6, sig);
    }

    function test_Claim_VoucherForOtherChannelRejected() public {
        bytes32 id1 = _open(DEP);
        bytes32 id2 = _open(DEP);
        assertTrue(id1 != id2);
        bytes memory sig1 = _sig(payerPk, id1, 50e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.claim(id2, 50e6, sig1);
        // still valid on its own channel
        vm.prank(payee);
        meter.claim(id1, 50e6, sig1);
        assertEq(usdc.balanceOf(payee), 50e6);
    }

    function test_Claim_OnlyPayee() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.NotPayee.selector);
        meter.claim(id, 10e6, sig);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.NotPayee.selector);
        meter.claim(id, 10e6, sig);
    }

    function test_Claim_UnknownChannel() public {
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.claim(bytes32(uint256(1)), 1, hex"");
    }

    function test_Claim_RevertsAfterExpiry() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.warp(expiry);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelExpired.selector);
        meter.claim(id, 10e6, sig);
    }

    function test_Claim_WorksJustBeforeExpiry() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry - 1);
        _claim(id, 10e6);
        assertEq(usdc.balanceOf(payee), 10e6);
    }

    function test_Claim_Erc1271WalletPayer() public {
        MockWallet1271 wallet = new MockWallet1271(foreign);
        usdc.mint(address(wallet), DEP);
        bytes32 id = wallet.approveAndOpen(IERC20(address(usdc)), meter, payee, DEP, expiry);

        // signed by wallet's authorised key over the digest
        bytes memory good = _sig(foreignPk, id, 30e6);
        vm.prank(payee);
        meter.claim(id, 30e6, good);
        assertEq(usdc.balanceOf(payee), 30e6);

        // signature from a non-authorised key is rejected
        bytes memory bad = _sig(payerPk, id, 60e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.claim(id, 60e6, bad);

        // close with 1271 voucher refunds the wallet
        bytes memory fin = _sig(foreignPk, id, 70e6);
        vm.prank(payee);
        meter.close(id, 70e6, fin);
        assertEq(usdc.balanceOf(payee), 70e6);
        assertEq(usdc.balanceOf(address(wallet)), DEP - 70e6);
    }

    function test_CheckVoucherSignature_OnlySelf() public {
        vm.expectRevert(ArcMeter.OnlySelf.selector);
        meter.checkVoucherSignature(payer, bytes32(0), hex"");
    }

    // ------------------------------------------------------------ close

    function test_Close_WithVoucherPaysDeltaAndRefunds() public {
        bytes32 id = _open(DEP);
        _claim(id, 100e6);
        bytes memory sig = _sig(payerPk, id, 400e6);
        uint256 payerBal = usdc.balanceOf(payer);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Closed(id, 300e6, DEP - 400e6);
        vm.prank(payee);
        meter.close(id, 400e6, sig);

        assertEq(usdc.balanceOf(payee), 400e6);
        assertEq(usdc.balanceOf(payer), payerBal + (DEP - 400e6));
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertFalse(_exists(id));
    }

    function test_Close_EmptySignatureRefundsAll() public {
        bytes32 id = _open(DEP);
        uint256 payerBal = usdc.balanceOf(payer);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Closed(id, 0, DEP);
        vm.prank(payee);
        meter.close(id, 999e6, hex""); // amount ignored with empty sig

        assertEq(usdc.balanceOf(payee), 0);
        assertEq(usdc.balanceOf(payer), payerBal + DEP);
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertFalse(_exists(id));
    }

    function test_Close_EmptySignatureRefundsOnlyUnclaimed() public {
        bytes32 id = _open(DEP);
        _claim(id, 300e6);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(usdc.balanceOf(payee), 300e6);
        assertEq(usdc.balanceOf(payer), payerBal + DEP - 300e6);
    }

    function test_Close_EmptySignatureAllowedAfterExpiry() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry + 10 days);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(usdc.balanceOf(payer), payerBal + DEP);
        assertFalse(_exists(id));
    }

    function test_Close_ThenClaimReverts_ChannelNotFound() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.claim(id, 10e6, sig);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.close(id, 0, hex"");
    }

    function test_Close_StaleVoucherPaysZero() public {
        bytes32 id = _open(DEP);
        _claim(id, 200e6);
        uint256 payerBal = usdc.balanceOf(payer);
        bytes memory stale = _sig(payerPk, id, 50e6);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Closed(id, 0, DEP - 200e6);
        vm.prank(payee);
        meter.close(id, 50e6, stale);

        assertEq(usdc.balanceOf(payee), 200e6, "no extra pay");
        assertEq(usdc.balanceOf(payer), payerBal + DEP - 200e6);
        assertFalse(_exists(id));
    }

    function test_Close_EqualVoucherPaysZero() public {
        bytes32 id = _open(DEP);
        _claim(id, 200e6);
        bytes memory same = _sig(payerPk, id, 200e6);
        vm.prank(payee);
        meter.close(id, 200e6, same);
        assertEq(usdc.balanceOf(payee), 200e6);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }

    function test_Close_OnlyPayee() public {
        bytes32 id = _open(DEP);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.NotPayee.selector);
        meter.close(id, 0, hex"");
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.NotPayee.selector);
        meter.close(id, 0, hex"");
        assertTrue(_exists(id));
    }

    function test_Close_UnknownChannel() public {
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.close(bytes32(uint256(7)), 0, hex"");
    }

    function test_Close_ForeignSignerReverts() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(foreignPk, id, 10e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.close(id, 10e6, sig);
    }

    function test_Close_ExceedsDeposit() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, uint256(DEP) + 1);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ExceedsDeposit.selector);
        meter.close(id, uint256(DEP) + 1, sig);
    }

    function test_Close_VoucherForOtherChannelRejected() public {
        bytes32 id1 = _open(DEP);
        bytes32 id2 = _open(DEP);
        bytes memory sig1 = _sig(payerPk, id1, 50e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.InvalidSignature.selector);
        meter.close(id2, 50e6, sig1);
    }

    function test_Close_WithSignatureRevertsAfterExpiry() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.warp(expiry);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelExpired.selector);
        meter.close(id, 10e6, sig);
    }

    // ------------------------------------------------------------ reclaim

    function test_Reclaim_AfterExpiryRefundsUnclaimed() public {
        bytes32 id = _open(DEP);
        _claim(id, 250e6);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.warp(expiry);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Reclaimed(id, DEP - 250e6);
        vm.prank(payer);
        meter.reclaim(id);

        assertEq(usdc.balanceOf(payer), payerBal + DEP - 250e6);
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertFalse(_exists(id));
    }

    function test_Reclaim_FullyClaimedRefundsZero() public {
        bytes32 id = _open(DEP);
        _claim(id, DEP);
        vm.warp(expiry);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.prank(payer);
        meter.reclaim(id);
        assertEq(usdc.balanceOf(payer), payerBal);
        assertFalse(_exists(id));
    }

    function test_Reclaim_RevertsBeforeExpiry() public {
        bytes32 id = _open(DEP);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelNotExpired.selector);
        meter.reclaim(id);
        vm.warp(expiry - 1);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelNotExpired.selector);
        meter.reclaim(id);
    }

    function test_Reclaim_OnlyPayer() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry + 1);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.reclaim(id);
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.reclaim(id);
    }

    function test_Reclaim_ThenClaimOrReclaimReverts() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.warp(expiry);
        vm.prank(payer);
        meter.reclaim(id);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.reclaim(id);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.claim(id, 10e6, sig);
    }

    // ------------------------------------------------------------ topUp

    function test_TopUp_IncreasesClaimableCeiling() public {
        bytes32 id = _open(DEP);
        uint256 over = uint256(DEP) + 100e6;
        bytes memory sig = _sig(payerPk, id, over);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ExceedsDeposit.selector);
        meter.claim(id, over, sig);

        vm.expectEmit(true, false, false, true, address(meter));
        emit ToppedUp(id, 100e6, DEP + 100e6);
        vm.prank(payer);
        meter.topUp(id, 100e6);

        assertEq(_deposit(id), DEP + 100e6);
        assertEq(usdc.balanceOf(address(meter)), over);
        vm.prank(payee);
        meter.claim(id, over, sig);
        assertEq(usdc.balanceOf(payee), over);
    }

    function test_TopUp_OnlyPayer() public {
        bytes32 id = _open(DEP);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.topUp(id, 1);
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.topUp(id, 1);
    }

    function test_TopUp_RejectedAfterExpiry() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelExpired.selector);
        meter.topUp(id, 1e6);
    }

    function test_TopUp_ZeroAmount() public {
        bytes32 id = _open(DEP);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.topUp(id, 0);
    }

    function test_TopUp_UnknownChannel() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.topUp(bytes32(uint256(9)), 1);
    }

    function test_TopUp_DepositOverflow() public {
        bytes32 id = _open(DEP);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.DepositOverflow.selector);
        meter.topUp(id, type(uint128).max);
    }

    // ------------------------------------------------------------ extend

    function test_Extend_PayerExtendsAndEmits() public {
        bytes32 id = _open(DEP);
        uint64 newExp = expiry + 7 days;
        vm.expectEmit(true, false, false, true, address(meter));
        emit Extended(id, expiry, newExp);
        vm.prank(payer);
        meter.extend(id, newExp);
        (,,,, uint64 e) = meter.channels(id);
        assertEq(e, newExp);

        // old expiry no longer blocks claims
        vm.warp(expiry + 1);
        _claim(id, 10e6);
        assertEq(usdc.balanceOf(payee), 10e6);
    }

    function test_Extend_MustBeStrictlyLater() public {
        bytes32 id = _open(DEP);
        vm.startPrank(payer);
        vm.expectRevert(ArcMeter.InvalidExpiry.selector);
        meter.extend(id, expiry);
        vm.expectRevert(ArcMeter.InvalidExpiry.selector);
        meter.extend(id, expiry - 1);
        vm.stopPrank();
    }

    function test_Extend_OnlyPayer() public {
        bytes32 id = _open(DEP);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.extend(id, expiry + 1);
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.extend(id, expiry + 1);
    }

    function test_Extend_UnknownChannel() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ChannelNotFound.selector);
        meter.extend(bytes32(uint256(3)), expiry);
    }

    function test_Extend_ExpiredChannelCanBeRevivedToFuture() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry + 5);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.InvalidExpiry.selector);
        meter.extend(id, uint64(block.timestamp)); // not in the future
        vm.prank(payer);
        meter.extend(id, uint64(block.timestamp + 1 days));
        _claim(id, 10e6);
        assertEq(usdc.balanceOf(payee), 10e6);
    }

    // ------------------------------------------------------------ redeemable

    function test_Redeemable_ValidCase() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 100e6);
        (bool ok, uint256 amt) = meter.redeemable(id, 100e6, sig);
        assertTrue(ok);
        assertEq(amt, 100e6);

        _claim(id, 100e6);
        sig = _sig(payerPk, id, 160e6);
        (ok, amt) = meter.redeemable(id, 160e6, sig);
        assertTrue(ok);
        assertEq(amt, 60e6, "incremental amount");
    }

    function test_Redeemable_WorksFromAnyAddress() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 100e6);
        address[4] memory callers = [payee, payer, stranger, address(0xdead)];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok, uint256 amt) = meter.redeemable(id, 100e6, sig);
            assertTrue(ok);
            assertEq(amt, 100e6);
        }
    }

    function test_Redeemable_FalseForStale() public {
        bytes32 id = _open(DEP);
        _claim(id, 100e6);
        (bool ok, uint256 amt) = meter.redeemable(id, 100e6, _sig(payerPk, id, 100e6));
        assertFalse(ok);
        assertEq(amt, 0);
        (ok, amt) = meter.redeemable(id, 50e6, _sig(payerPk, id, 50e6));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForOverDeposit() public {
        bytes32 id = _open(DEP);
        uint256 over = uint256(DEP) + 1;
        (bool ok, uint256 amt) = meter.redeemable(id, over, _sig(payerPk, id, over));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForWrongSigner() public {
        bytes32 id = _open(DEP);
        (bool ok, uint256 amt) = meter.redeemable(id, 10e6, _sig(foreignPk, id, 10e6));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseWhenAmountDiffersFromSigned() public {
        bytes32 id = _open(DEP);
        (bool ok, uint256 amt) = meter.redeemable(id, 11e6, _sig(payerPk, id, 10e6));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForOtherChannelVoucher() public {
        bytes32 id1 = _open(DEP);
        bytes32 id2 = _open(DEP);
        (bool ok, uint256 amt) = meter.redeemable(id2, 10e6, _sig(payerPk, id1, 10e6));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseWhenExpired() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.warp(expiry);
        (bool ok, uint256 amt) = meter.redeemable(id, 10e6, sig);
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForUnknownChannel() public view {
        (bool ok, uint256 amt) = meter.redeemable(bytes32(uint256(42)), 10e6, hex"");
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForClosedChannel() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 10e6);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        (bool ok, uint256 amt) = meter.redeemable(id, 10e6, sig);
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function test_Redeemable_FalseForMalformedSignature() public {
        bytes32 id = _open(DEP);
        (bool ok, uint256 amt) = meter.redeemable(id, 10e6, hex"1234");
        assertFalse(ok);
        assertEq(amt, 0);
        (ok, amt) = meter.redeemable(id, 10e6, hex"");
        assertFalse(ok);
        assertEq(amt, 0);
        (ok, amt) = meter.redeemable(id, 10e6, new bytes(65)); // all-zero sig
        assertFalse(ok);
        assertEq(amt, 0);
        (ok, amt) = meter.redeemable(id, 10e6, new bytes(200));
        assertFalse(ok);
        assertEq(amt, 0);
    }

    function testFuzz_Redeemable_NeverReverts(bytes32 id, uint256 amt, bytes calldata sig) public {
        bytes32 real = _open(DEP);
        meter.redeemable(id, amt, sig);
        meter.redeemable(real, amt, sig);
    }

    function test_Redeemable_Erc1271Wallet_ValidAndReverting() public {
        MockWallet1271 wallet = new MockWallet1271(foreign);
        usdc.mint(address(wallet), DEP);
        bytes32 id = wallet.approveAndOpen(IERC20(address(usdc)), meter, payee, DEP, expiry);
        bytes memory sig = _sig(foreignPk, id, 25e6);

        (bool ok, uint256 amt) = meter.redeemable(id, 25e6, sig);
        assertTrue(ok);
        assertEq(amt, 25e6);

        wallet.setRevert(true);
        (ok, amt) = meter.redeemable(id, 25e6, sig); // must not revert
        assertFalse(ok);
        assertEq(amt, 0);

        // claim itself does not silently succeed with a reverting wallet
        vm.prank(payee);
        vm.expectRevert();
        meter.claim(id, 25e6, sig);
    }

    // ------------------------------------------------------------ fuzz: conservation of funds

    function _runClaims(bytes32 id, uint256 seed, uint256 n, uint256 total) internal returns (uint256 claimed) {
        for (uint256 i; i < n; i++) {
            uint256 cum = bound(uint256(keccak256(abi.encode(seed, i))), 0, total);
            bytes memory sig = _sig(payerPk, id, cum);
            vm.prank(payee);
            if (cum > claimed) {
                meter.claim(id, cum, sig);
                claimed = cum;
            } else {
                vm.expectRevert(ArcMeter.NothingToClaim.selector);
                meter.claim(id, cum, sig);
            }
        }
    }

    function _finish(bytes32 id, uint256 seed, uint256 total, uint256 claimed, bool useReclaim, bool finalVoucher)
        internal
    {
        if (useReclaim) {
            vm.warp(expiry);
            vm.prank(payer);
            meter.reclaim(id);
        } else if (finalVoucher) {
            uint256 cum = bound(uint256(keccak256(abi.encode(seed, "final"))), 0, total);
            bytes memory sig = _sig(payerPk, id, cum);
            vm.prank(payee);
            meter.close(id, cum, sig);
            if (cum > claimed) {
                // paid exactly the delta
                assertEq(usdc.balanceOf(payee) - payeeBefore, cum);
            }
        } else {
            vm.prank(payee);
            meter.close(id, 0, hex"");
        }
    }

    function testFuzz_ConservationOfFunds(
        uint128 dep,
        uint128 top,
        uint256 seed,
        uint8 nClaims,
        bool useReclaim,
        bool finalVoucher
    ) public {
        dep = uint128(bound(dep, 1, 1e18));
        top = uint128(bound(top, 0, 1e18));
        uint256 total = uint256(dep) + top;
        uint256 n = bound(nClaims, 0, 8);

        payerBefore = usdc.balanceOf(payer);
        payeeBefore = usdc.balanceOf(payee);
        uint256 meterBefore = usdc.balanceOf(address(meter));

        bytes32 id = _open(dep);
        if (top > 0) {
            vm.prank(payer);
            meter.topUp(id, top);
        }
        assertEq(usdc.balanceOf(address(meter)) - meterBefore, total);

        uint256 claimed = _runClaims(id, seed, n, total);
        assertEq(usdc.balanceOf(address(meter)) - meterBefore, total - claimed, "escrow = unclaimed");

        _finish(id, seed, total, claimed, useReclaim, finalVoucher);

        uint256 payeeGot = usdc.balanceOf(payee) - payeeBefore;
        uint256 payerRefund = usdc.balanceOf(payer) + total - payerBefore;
        assertEq(payeeGot + payerRefund + usdc.balanceOf(address(meter)), total, "conservation");
        assertEq(usdc.balanceOf(address(meter)), meterBefore, "meter empty after delete");
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertFalse(_exists(id));
    }

    // ------------------------------------------------------------ close: blocklisted payer / pull refunds

    function test_Close_BlocklistedPayer_PayeePaidRefundCreditedChannelDeleted() public {
        bytes32 id = _open(DEP);
        _claim(id, 100e6);
        bytes memory sig = _sig(payerPk, id, 400e6);
        uint256 payerBal = usdc.balanceOf(payer);
        usdc.setBlocked(payer, true);

        vm.expectEmit(true, false, false, true, address(meter));
        emit Closed(id, 300e6, DEP - 400e6);
        vm.expectEmit(true, false, false, true, address(meter));
        emit RefundCredited(payer, DEP - 400e6);
        vm.prank(payee);
        meter.close(id, 400e6, sig);

        assertEq(usdc.balanceOf(payee), 400e6, "payee fully paid");
        assertEq(usdc.balanceOf(payer), payerBal, "payer got nothing directly");
        assertEq(meter.pendingRefunds(payer), DEP - 400e6);
        assertEq(usdc.balanceOf(address(meter)), DEP - 400e6, "refund held by meter");
        assertFalse(_exists(id), "channel deleted");
    }

    function test_Close_BlocklistedPayer_EmptySigFullRefundCredited() public {
        bytes32 id = _open(DEP);
        usdc.setBlocked(payer, true);
        vm.expectEmit(true, false, false, true, address(meter));
        emit RefundCredited(payer, DEP);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(meter.pendingRefunds(payer), DEP);
        assertEq(usdc.balanceOf(address(meter)), DEP);
        assertFalse(_exists(id));
    }

    function test_Close_PayerTransferReturnsFalse_RefundCredited() public {
        bytes32 id = _open(DEP);
        usdc.setBlocked(payer, true);
        usdc.setSoftFail(true); // transfer returns false instead of reverting
        vm.expectEmit(true, false, false, true, address(meter));
        emit RefundCredited(payer, DEP);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(meter.pendingRefunds(payer), DEP);
        assertEq(usdc.balanceOf(address(meter)), DEP);
        assertFalse(_exists(id));
    }

    function test_Close_BlocklistedPayer_ExpiredChannelStillCloses() public {
        bytes32 id = _open(DEP);
        vm.warp(expiry + 1 days);
        usdc.setBlocked(payer, true);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(meter.pendingRefunds(payer), DEP);
        assertFalse(_exists(id));
    }

    function test_Close_BlocklistedPayer_FullyClaimedCreditsNothing() public {
        bytes32 id = _open(DEP);
        _claim(id, DEP);
        usdc.setBlocked(payer, true);
        vm.recordLogs();
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(meter.pendingRefunds(payer), 0);
        assertEq(usdc.balanceOf(address(meter)), 0);
        assertFalse(_exists(id));
        // only the Closed event: no RefundCredited
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != RefundCredited.selector, "no credit event");
        }
    }

    function test_Close_UnblockedPayer_NoCreditEmitted() public {
        bytes32 id = _open(DEP);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.recordLogs();
        vm.prank(payee);
        meter.close(id, 0, hex"");
        assertEq(meter.pendingRefunds(payer), 0);
        assertEq(usdc.balanceOf(payer), payerBal + DEP);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != RefundCredited.selector, "no credit event");
        }
    }

    function test_Close_BlocklistedPayer_CreditsAccumulateAcrossChannels() public {
        bytes32 id1 = _open(DEP);
        bytes32 id2 = _open(DEP / 2);
        usdc.setBlocked(payer, true);
        vm.startPrank(payee);
        meter.close(id1, 0, hex"");
        meter.close(id2, 0, hex"");
        vm.stopPrank();
        assertEq(meter.pendingRefunds(payer), uint256(DEP) + DEP / 2);
        assertEq(usdc.balanceOf(address(meter)), uint256(DEP) + DEP / 2);
    }

    function test_Redeemable_CallerIndependentWhilePayerBlocklisted() public {
        bytes32 id = _open(DEP);
        bytes memory sig = _sig(payerPk, id, 100e6);
        usdc.setBlocked(payer, true);
        address[3] memory callers = [payee, payer, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok, uint256 amt) = meter.redeemable(id, 100e6, sig);
            assertTrue(ok);
            assertEq(amt, 100e6);
        }
    }

    // ------------------------------------------------------------ withdrawRefund

    function _closeBlocked(uint256 claimedAmt) internal returns (uint256 refund) {
        bytes32 id = _open(DEP);
        if (claimedAmt != 0) _claim(id, claimedAmt);
        usdc.setBlocked(payer, true);
        vm.prank(payee);
        meter.close(id, 0, hex"");
        refund = DEP - claimedAmt;
        assertEq(meter.pendingRefunds(payer), refund);
    }

    function test_WithdrawRefund_FailsWhileBlocklisted() public {
        uint256 refund = _closeBlocked(0);
        vm.prank(payer);
        vm.expectRevert();
        meter.withdrawRefund();
        // failed withdrawal leaves the credit intact
        assertEq(meter.pendingRefunds(payer), refund);
        assertEq(usdc.balanceOf(address(meter)), refund);
    }

    function test_WithdrawRefund_FailsWhenTokenReturnsFalse() public {
        uint256 refund = _closeBlocked(0);
        usdc.setSoftFail(true);
        vm.prank(payer);
        vm.expectRevert();
        meter.withdrawRefund();
        assertEq(meter.pendingRefunds(payer), refund);
    }

    function test_WithdrawRefund_SucceedsAfterUnblock() public {
        uint256 refund = _closeBlocked(300e6);
        uint256 payerBal = usdc.balanceOf(payer);
        usdc.setBlocked(payer, false);

        vm.expectEmit(true, false, false, true, address(meter));
        emit RefundWithdrawn(payer, refund);
        vm.prank(payer);
        meter.withdrawRefund();

        assertEq(usdc.balanceOf(payer), payerBal + refund);
        assertEq(meter.pendingRefunds(payer), 0);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }

    function test_WithdrawRefund_CannotBeRepeated() public {
        _closeBlocked(0);
        usdc.setBlocked(payer, false);
        vm.prank(payer);
        meter.withdrawRefund();
        uint256 payerBal = usdc.balanceOf(payer);
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.withdrawRefund();
        assertEq(usdc.balanceOf(payer), payerBal);
    }

    function test_WithdrawRefund_RevertsZeroAmountWhenNothingPending() public {
        vm.prank(payer);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.withdrawRefund();
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.withdrawRefund();
    }

    function test_WithdrawRefund_OnlyPaysCallersOwnCredit() public {
        uint256 refund = _closeBlocked(0);
        usdc.setBlocked(payer, false);
        uint256 strangerBal = usdc.balanceOf(stranger);
        vm.prank(stranger);
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.withdrawRefund();
        assertEq(usdc.balanceOf(stranger), strangerBal);
        assertEq(meter.pendingRefunds(payer), refund);
    }

    function test_WithdrawRefund_PartialStateAcrossTwoCredits() public {
        _closeBlocked(0);
        usdc.setBlocked(payer, false);
        bytes32 id2 = _open(50e6); // a blocklisted payer cannot fund; unblock to open
        usdc.setBlocked(payer, true);
        vm.prank(payee);
        meter.close(id2, 0, hex""); // payer still blocked -> second credit
        assertEq(meter.pendingRefunds(payer), uint256(DEP) + 50e6);
        usdc.setBlocked(payer, false);
        uint256 payerBal = usdc.balanceOf(payer);
        vm.prank(payer);
        meter.withdrawRefund();
        assertEq(usdc.balanceOf(payer), payerBal + DEP + 50e6);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }

    // ------------------------------------------------------------ fuzz: conservation incl. pending refunds

    function testFuzz_Close_BlocklistConservation(
        uint128 dep,
        uint256 cum,
        bool isBlocked,
        bool soft,
        bool withVoucher
    ) public {
        dep = uint128(bound(dep, 1, 1e18));
        cum = bound(cum, 0, dep);
        payerBefore = usdc.balanceOf(payer);
        payeeBefore = usdc.balanceOf(payee);

        bytes32 id = _open(dep);
        usdc.setBlocked(payer, isBlocked);
        usdc.setSoftFail(soft);
        bytes memory sig = withVoucher ? _sig(payerPk, id, cum) : bytes("");
        uint256 paid = withVoucher ? cum : 0;
        uint256 refund = dep - paid;

        vm.prank(payee);
        meter.close(id, cum, sig);

        assertEq(usdc.balanceOf(payee) - payeeBefore, paid, "payee paid regardless of payer status");
        assertFalse(_exists(id));
        uint256 pending = meter.pendingRefunds(payer);
        assertEq(pending, isBlocked ? refund : 0, "credit iff blocked");
        assertEq(usdc.balanceOf(address(meter)), pending, "meter balance == pending credits");
        assertEq(usdc.balanceOf(payer), isBlocked ? payerBefore - dep : payerBefore - dep + refund);

        if (pending != 0) {
            usdc.setBlocked(payer, false);
            vm.prank(payer);
            meter.withdrawRefund();
            assertEq(usdc.balanceOf(payer), payerBefore - dep + refund);
            assertEq(meter.pendingRefunds(payer), 0);
            assertEq(usdc.balanceOf(address(meter)), 0);
        }
    }
}

/// @dev Stateful handler: random opens/claims/closes/blocklist toggles/withdrawals.
contract ArcMeterHandler is Test {
    ArcMeter internal meter;
    MockUSDC6 internal usdc;
    address internal payee;

    address[3] public actors;
    uint256[3] internal pks;
    bytes32[] internal ids;
    mapping(bytes32 => uint256) internal dep;
    mapping(bytes32 => uint256) internal clm;
    mapping(bytes32 => bool) internal live;

    /// @dev Sum of unclaimed deposits of live channels.
    uint256 public escrow;

    constructor(ArcMeter meter_, MockUSDC6 usdc_, address payee_) {
        meter = meter_;
        usdc = usdc_;
        payee = payee_;
        for (uint256 i; i < 3; i++) {
            (actors[i], pks[i]) = makeAddrAndKey(string.concat("actor", vm.toString(i)));
            usdc.mint(actors[i], 1e30);
            vm.prank(actors[i]);
            usdc.approve(address(meter), type(uint256).max);
        }
    }

    function sumPending() public view returns (uint256 s) {
        for (uint256 i; i < 3; i++) s += meter.pendingRefunds(actors[i]);
    }

    function open(uint256 a, uint256 amt) external {
        uint256 i = a % 3;
        if (usdc.blocked(actors[i])) return; // blocklisted accounts cannot fund
        amt = bound(amt, 1, 1e12);
        vm.prank(actors[i]);
        bytes32 id = meter.open(payee, uint128(amt), uint64(block.timestamp + 1 days));
        ids.push(id);
        dep[id] = amt;
        live[id] = true;
        escrow += amt;
    }

    function _pick(uint256 seed) internal view returns (bool ok, bytes32 id, uint256 idx) {
        if (ids.length == 0) return (false, bytes32(0), 0);
        id = ids[seed % ids.length];
        if (!live[id]) return (false, id, 0);
        (address p,,,,) = meter.channels(id);
        for (uint256 i; i < 3; i++) {
            if (actors[i] == p) idx = i;
        }
        return (true, id, idx);
    }

    function claim(uint256 seed, uint256 cum) external {
        (bool ok, bytes32 id, uint256 idx) = _pick(seed);
        if (!ok) return;
        cum = bound(cum, 0, dep[id]);
        if (cum <= clm[id]) return;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[idx], meter.voucherDigest(id, cum));
        vm.prank(payee);
        meter.claim(id, cum, abi.encodePacked(r, s, v));
        escrow -= cum - clm[id];
        clm[id] = cum;
    }

    function close(uint256 seed, uint256 cum, bool withVoucher) external {
        (bool ok, bytes32 id, uint256 idx) = _pick(seed);
        if (!ok) return;
        cum = bound(cum, 0, dep[id]);
        bytes memory sig;
        if (withVoucher) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[idx], meter.voucherDigest(id, cum));
            sig = abi.encodePacked(r, s, v);
        }
        vm.prank(payee);
        meter.close(id, cum, sig);
        escrow -= dep[id] - clm[id];
        live[id] = false;
    }

    function setBlocked(uint256 a, bool v) external {
        usdc.setBlocked(actors[a % 3], v);
    }

    function setSoftFail(bool v) external {
        usdc.setSoftFail(v);
    }

    function withdraw(uint256 a) external {
        address actor = actors[a % 3];
        uint256 pend = meter.pendingRefunds(actor);
        bool isBlocked = usdc.blocked(actor);
        if (pend == 0) {
            vm.prank(actor);
            vm.expectRevert(ArcMeter.ZeroAmount.selector);
            meter.withdrawRefund();
        } else if (isBlocked) {
            vm.prank(actor);
            vm.expectRevert();
            meter.withdrawRefund();
        } else {
            vm.prank(actor);
            meter.withdrawRefund();
        }
    }
}

contract ArcMeterInvariantTest is Test {
    ArcMeter internal meter;
    MockUSDC6 internal usdc;
    ArcMeterHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC6();
        meter = new ArcMeter(IERC20(address(usdc)));
        handler = new ArcMeterHandler(meter, usdc, makeAddr("payee"));
        targetContract(address(handler));
    }

    /// @dev Meter token balance == unclaimed escrow of live channels + all pending refund credits.
    function invariant_BalanceEqualsEscrowPlusPendingRefunds() public view {
        assertEq(usdc.balanceOf(address(meter)), handler.escrow() + handler.sumPending());
    }
}
