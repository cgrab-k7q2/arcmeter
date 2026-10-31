// ArcMeter SDK: pay-per-call USDC on Arc with off-chain vouchers.
// Client: sign a cumulative voucher per request.  Server: verify it in microseconds, settle on-chain later.
import { recoverTypedDataAddress, getAddress, parseAbi } from 'viem';

export const USDC = '0x3600000000000000000000000000000000000000'; // Arc USDC ERC-20 interface (6 decimals)
export const HEADER = 'x-arcmeter-voucher';

export { arc as arcMainnet, arcTestnet } from 'viem/chains';

export const arcMeterAbi = parseAbi([
  'function open(address payee, uint128 amount, uint64 expiresAt) returns (bytes32 id)',
  'function topUp(bytes32 id, uint128 amount)',
  'function extend(bytes32 id, uint64 expiresAt)',
  'function reclaim(bytes32 id)',
  'function claim(bytes32 id, uint256 cumulativeAmount, bytes signature) returns (uint256 paid)',
  'function close(bytes32 id, uint256 cumulativeAmount, bytes signature)',
  'function channels(bytes32 id) view returns (address payer, address payee, uint128 deposit, uint128 claimed, uint64 expiresAt)',
  'function redeemable(bytes32 id, uint256 cumulativeAmount, bytes signature) view returns (bool ok, uint256 amount)',
  'function voucherDigest(bytes32 id, uint256 cumulativeAmount) view returns (bytes32)',
  'event ChannelOpened(bytes32 indexed id, address indexed payer, address indexed payee, uint256 deposit, uint64 expiresAt)',
  'event Claimed(bytes32 indexed id, address indexed payee, uint256 amount, uint256 cumulative)',
  'event ChannelClosed(bytes32 indexed id, uint256 paidToPayee, uint256 refundedToPayer)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

export function voucherTypedData({ chainId, meter, channelId, cumulativeAmount }) {
  return {
    domain: { name: 'ArcMeter', version: '1', chainId, verifyingContract: getAddress(meter) },
    types: { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }] },
    primaryType: 'Voucher',
    message: { channelId, cumulativeAmount: BigInt(cumulativeAmount) },
  };
}

export function encodeVoucher(v) {
  return Buffer.from(JSON.stringify({ c: v.channelId, a: v.cumulativeAmount.toString(), s: v.signature })).toString('base64url');
}

export function decodeVoucher(header) {
  const o = JSON.parse(Buffer.from(String(header), 'base64url').toString('utf8'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.c) || !/^\d+$/.test(o.a) || !/^0x[0-9a-fA-F]+$/.test(o.s)) throw new Error('malformed voucher');
  return { channelId: o.c, cumulativeAmount: BigInt(o.a), signature: o.s };
}

/** Client side: keeps the running total and signs one voucher per paid call. */
export function createPayer({ account, walletClient, chainId, meter, channelId, startAt = 0n }) {
  let cumulative = BigInt(startAt);
  const sign = async (typed) =>
    account?.signTypedData ? account.signTypedData(typed) : walletClient.signTypedData({ account: walletClient.account, ...typed });
  return {
    get spent() { return cumulative; },
    async pay(amount) {
      const next = cumulative + BigInt(amount);
      const signature = await sign(voucherTypedData({ chainId, meter, channelId, cumulativeAmount: next }));
      cumulative = next;
      return encodeVoucher({ channelId, cumulativeAmount: next, signature });
    },
    /** fetch() wrapper that pays `price` per request via the voucher header. */
    async fetch(url, init = {}, price) {
      const headers = new Headers(init.headers || {});
      headers.set(HEADER, await this.pay(price));
      return fetch(url, { ...init, headers });
    },
  };
}

/** Server side: verify vouchers off-chain; remembers the best voucher per channel for settlement. */
export function createMeterGuard({ publicClient, chainId, meter, payee, price, safetyMarginSec = 300, now = () => Math.floor(Date.now() / 1000) }) {
  const best = new Map(); // channelId -> { cumulativeAmount, signature }
  const cache = new Map(); // channelId -> channel struct
  const pay = getAddress(payee);

  async function channel(id, refresh = false) {
    if (!refresh && cache.has(id)) return cache.get(id);
    const [payer, chPayee, deposit, claimed, expiresAt] = await publicClient.readContract({
      address: meter, abi: arcMeterAbi, functionName: 'channels', args: [id],
    });
    const c = { payer, payee: chPayee, deposit, claimed, expiresAt: Number(expiresAt) };
    cache.set(id, c);
    return c;
  }

  return {
    best,
    /** Returns { ok: true, channelId, charged } or { ok: false, status, error }. */
    async check(header, cost = price) {
      let v;
      try { v = decodeVoucher(header); } catch { return { ok: false, status: 402, error: 'missing or malformed voucher' }; }
      let c = await channel(v.channelId);
      if (c.payer === '0x0000000000000000000000000000000000000000') return { ok: false, status: 402, error: 'unknown channel' };
      if (getAddress(c.payee) !== pay) return { ok: false, status: 402, error: 'channel pays someone else' };
      if (c.expiresAt - safetyMarginSec <= now()) return { ok: false, status: 402, error: 'channel expires too soon' };
      const prev = best.get(v.channelId)?.cumulativeAmount ?? c.claimed;
      if (v.cumulativeAmount < prev + BigInt(cost)) return { ok: false, status: 402, error: 'voucher does not cover this call' };
      if (v.cumulativeAmount > c.deposit) {
        c = await channel(v.channelId, true); // maybe topped up
        if (v.cumulativeAmount > c.deposit) return { ok: false, status: 402, error: 'insufficient channel balance' };
      }
      const signer = await recoverTypedDataAddress({
        ...voucherTypedData({ chainId, meter, channelId: v.channelId, cumulativeAmount: v.cumulativeAmount }),
        signature: v.signature,
      });
      if (getAddress(signer) !== getAddress(c.payer)) return { ok: false, status: 402, error: 'bad signature' };
      best.set(v.channelId, { cumulativeAmount: v.cumulativeAmount, signature: v.signature });
      return { ok: true, channelId: v.channelId, charged: v.cumulativeAmount - prev };
    },
    /** Settle the best voucher on-chain (claim, or close to also refund the payer). */
    async settle(walletClient, channelId, { close = false } = {}) {
      const b = best.get(channelId);
      if (!b && !close) throw new Error('nothing to settle');
      const hash = await walletClient.writeContract({
        address: meter, abi: arcMeterAbi, account: walletClient.account, chain: walletClient.chain,
        functionName: close ? 'close' : 'claim',
        args: [channelId, b?.cumulativeAmount ?? 0n, b?.signature ?? '0x'],
      });
      cache.delete(channelId);
      return hash;
    },
  };
}

/** Minimal Node http / Express-compatible middleware: 402 unless a valid voucher pays for the call. */
export function meterMiddleware(guard, cost) {
  return async (req, res, next) => {
    const r = await guard.check(req.headers[HEADER], cost);
    if (!r.ok) {
      res.statusCode = r.status;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: r.error, accepts: 'arcmeter-voucher', header: HEADER }));
    }
    req.arcmeter = r;
    return next();
  };
}
