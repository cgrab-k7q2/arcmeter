// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArcMeter} from "../src/ArcMeter.sol";

contract MockUSDC is ERC20("USD Coin", "USDC") {
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract ArcMeterTest is Test {
    MockUSDC usdc;
    ArcMeter meter;
    uint256 payerPk = 0xA11CE;
    address payer;
    address payee = address(0xB0B);
    address mallory = address(0xBAD);

    function setUp() public {
        usdc = new MockUSDC();
        meter = new ArcMeter(IERC20(address(usdc)));
        payer = vm.addr(payerPk);
        usdc.mint(payer, 100e6);
        vm.prank(payer);
        usdc.approve(address(meter), type(uint256).max);
    }

    function _open(uint128 amt) internal returns (bytes32 id) {
        vm.prank(payer);
        id = meter.open(payee, amt, uint64(block.timestamp + 1 days));
    }

    function _sign(uint256 pk, bytes32 id, uint256 cum) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, meter.voucherDigest(id, cum));
        return abi.encodePacked(r, s, v);
    }

    function test_openLocksFunds() public {
        bytes32 id = _open(10e6);
        (address p, address q, uint128 dep, uint128 cl, uint64 exp) = meter.channels(id);
        assertEq(p, payer); assertEq(q, payee); assertEq(dep, 10e6); assertEq(cl, 0);
        assertEq(exp, block.timestamp + 1 days);
        assertEq(usdc.balanceOf(address(meter)), 10e6);
    }

    function test_channelIdsUnique() public {
        bytes32 a = _open(1e6);
        bytes32 b = _open(1e6);
        assertTrue(a != b);
    }

    function test_incrementalClaims() public {
        bytes32 id = _open(10e6);
        vm.startPrank(payee);
        assertEq(meter.claim(id, 1e6, _sign(payerPk, id, 1e6)), 1e6);
        assertEq(meter.claim(id, 2_500_000, _sign(payerPk, id, 2_500_000)), 1_500_000);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), 2_500_000);
    }

    function test_staleVoucherReverts() public {
        bytes32 id = _open(10e6);
        bytes memory s3 = _sign(payerPk, id, 3e6);
        bytes memory s1 = _sign(payerPk, id, 1e6);
        vm.startPrank(payee);
        meter.claim(id, 3e6, s3);
        vm.expectRevert(ArcMeter.NothingToClaim.selector);
        meter.claim(id, 1e6, s1);
        vm.expectRevert(ArcMeter.NothingToClaim.selector);
        meter.claim(id, 3e6, s3); // replay
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), 3e6);
    }

    function test_cannotExceedDeposit() public {
        bytes32 id = _open(1e6);
        bytes memory s = _sign(payerPk, id, 2e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ExceedsDeposit.selector);
        meter.claim(id, 2e6, s);
    }

    function test_rejectsForeignSigner() public {
        bytes32 id = _open(5e6);
        bytes memory s = _sign(0xDEAD, id, 1e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.BadSignature.selector);
        meter.claim(id, 1e6, s);
    }

    function test_voucherBoundToChannel() public {
        bytes32 a = _open(5e6);
        bytes32 b = _open(5e6);
        bytes memory sa = _sign(payerPk, a, 1e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.BadSignature.selector);
        meter.claim(b, 1e6, sa);
    }

    function test_onlyPayeeClaims() public {
        bytes32 id = _open(5e6);
        bytes memory s = _sign(payerPk, id, 1e6);
        vm.prank(mallory);
        vm.expectRevert(ArcMeter.NotPayee.selector);
        meter.claim(id, 1e6, s);
    }

    function test_closeSettlesAndRefunds() public {
        bytes32 id = _open(10e6);
        bytes memory s = _sign(payerPk, id, 4e6);
        vm.prank(payee);
        meter.close(id, 4e6, s);
        assertEq(usdc.balanceOf(payee), 4e6);
        assertEq(usdc.balanceOf(payer), 96e6);
        assertEq(usdc.balanceOf(address(meter)), 0);
        (address p,,,,) = meter.channels(id);
        assertEq(p, address(0));
    }

    function test_closeWithoutVoucherRefundsAll() public {
        bytes32 id = _open(10e6);
        vm.prank(payee);
        meter.close(id, 0, "");
        assertEq(usdc.balanceOf(payer), 100e6);
    }

    function test_reclaimOnlyAfterExpiry() public {
        bytes32 id = _open(10e6);
        vm.startPrank(payer);
        vm.expectRevert(ArcMeter.NotExpired.selector);
        meter.reclaim(id);
        vm.stopPrank();

        bytes memory s = _sign(payerPk, id, 3e6);
        vm.prank(payee);
        meter.claim(id, 3e6, s);

        vm.warp(block.timestamp + 1 days + 1);
        bytes memory s2 = _sign(payerPk, id, 5e6);
        vm.prank(payee);
        vm.expectRevert(ArcMeter.ChannelExpired.selector);
        meter.claim(id, 5e6, s2);

        vm.prank(mallory);
        vm.expectRevert(ArcMeter.NotPayer.selector);
        meter.reclaim(id);

        vm.prank(payer);
        meter.reclaim(id);
        assertEq(usdc.balanceOf(payer), 97e6);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }

    /// Documents intended behaviour: an expired, unreclaimed channel can be revived by the payer.
    function test_extendRevivesExpiredUnreclaimedChannel() public {
        bytes32 id = _open(1e6);
        vm.warp(block.timestamp + 2 days);
        bytes memory s = _sign(payerPk, id, 5e5);
        (bool ok,) = meter.redeemable(id, 5e5, s);
        assertFalse(ok);
        vm.prank(payee);
        vm.expectRevert();
        meter.extend(id, uint64(block.timestamp + 1 days)); // only the payer
        vm.prank(payer);
        meter.extend(id, uint64(block.timestamp + 1 days));
        vm.prank(payee);
        meter.claim(id, 5e5, s);
        assertEq(usdc.balanceOf(payee), 5e5);
    }

    function test_topUpAndExtend() public {
        bytes32 id = _open(1e6);
        vm.startPrank(payer);
        meter.topUp(id, 2e6);
        meter.extend(id, uint64(block.timestamp + 2 days));
        vm.expectRevert(ArcMeter.BadExpiry.selector);
        meter.extend(id, uint64(block.timestamp + 1 hours));
        vm.stopPrank();
        (,, uint128 dep,, uint64 exp) = meter.channels(id);
        assertEq(dep, 3e6);
        assertEq(exp, block.timestamp + 2 days);
        bytes memory s = _sign(payerPk, id, 3e6);
        vm.prank(payee);
        meter.claim(id, 3e6, s);
        assertEq(usdc.balanceOf(payee), 3e6);
    }

    function test_redeemableView() public {
        bytes32 id = _open(5e6);
        bytes memory s = _sign(payerPk, id, 2e6);
        (bool ok, uint256 amt) = meter.redeemable(id, 2e6, s);
        assertTrue(ok); assertEq(amt, 2e6);
        (ok,) = meter.redeemable(id, 6e6, _sign(payerPk, id, 6e6));
        assertFalse(ok);
        (ok,) = meter.redeemable(id, 2e6, _sign(0xDEAD, id, 2e6));
        assertFalse(ok);
    }

    function test_openValidation() public {
        vm.startPrank(payer);
        vm.expectRevert(ArcMeter.ZeroAddress.selector);
        meter.open(address(0), 1e6, uint64(block.timestamp + 1));
        vm.expectRevert(ArcMeter.ZeroAmount.selector);
        meter.open(payee, 0, uint64(block.timestamp + 1));
        vm.expectRevert(ArcMeter.BadExpiry.selector);
        meter.open(payee, 1e6, uint64(block.timestamp));
        vm.stopPrank();
    }

    /// Fuzz: any sequence of increasing vouchers pays exactly the max, and funds are conserved.
    function testFuzz_conservation(uint128 deposit, uint128 a, uint128 b) public {
        deposit = uint128(bound(deposit, 1, 100e6));
        a = uint128(bound(a, 1, deposit));
        b = uint128(bound(b, a, deposit));
        bytes32 id = _open(deposit);
        vm.startPrank(payee);
        meter.claim(id, a, _sign(payerPk, id, a));
        if (b > a) meter.claim(id, b, _sign(payerPk, id, b));
        meter.close(id, 0, "");
        vm.stopPrank();
        assertEq(usdc.balanceOf(payee), b);
        assertEq(usdc.balanceOf(payer), 100e6 - b);
        assertEq(usdc.balanceOf(address(meter)), 0);
    }
}
