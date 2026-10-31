import { BaseError, parseAbi, type Address, type Hex } from 'viem'

export const arcMeterAbi = parseAbi([
  'constructor(address usdc_)',
  'function usdc() view returns (address)',
  'function channels(bytes32 id) view returns (address payer, address payee, uint128 deposit, uint128 claimed, uint64 expiresAt)',
  'function open(address payee, uint128 amount, uint64 expiresAt) returns (bytes32 id)',
  'function claim(bytes32 id, uint256 cumulativeAmount, bytes signature)',
  'function close(bytes32 id, uint256 cumulativeAmount, bytes signature)',
  'function topUp(bytes32 id, uint128 amount)',
  'function extend(bytes32 id, uint64 newExpiresAt)',
  'function reclaim(bytes32 id)',
  'function redeemable(bytes32 id, uint256 cumulativeAmount, bytes signature) view returns (bool ok, uint256 amount)',
  'function voucherDigest(bytes32 channelId, uint256 cumulativeAmount) view returns (bytes32)',
  'event ChannelOpened(bytes32 indexed id, address indexed payer, address indexed payee, uint128 amount, uint64 expiresAt)',
  'error ZeroAddress()',
  'error SelfPayment()',
  'error ZeroAmount()',
  'error InvalidExpiry()',
  'error ChannelNotFound()',
  'error NotPayee()',
  'error NotPayer()',
  'error NothingToClaim()',
  'error ExceedsDeposit()',
  'error ChannelExpired()',
  'error ChannelNotExpired()',
  'error InvalidSignature()',
  'error DepositOverflow()',
])

/** EIP-712 types for the payer's cumulative voucher (domain: ArcMeter / 1). */
export const voucherTypes = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
} as const

export function voucherDomain(chainId: number, verifyingContract: Address) {
  return { name: 'ArcMeter', version: '1', chainId, verifyingContract } as const
}

export interface Voucher {
  /** channel id */
  c: Hex
  /** cumulative amount, USDC base units */
  a: bigint
  /** payer signature */
  s: Hex
}

export const VOUCHER_HEADER = 'x-arcmeter-voucher'

const toBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
}

/** base64url(JSON {c, a, s}) for the x-arcmeter-voucher header. `a` is a decimal string. */
export function encodeVoucher(v: Voucher): string {
  const json = JSON.stringify({ c: v.c, a: v.a.toString(), s: v.s })
  return toBase64Url(new TextEncoder().encode(json))
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/

/** Accepts a bare token or a full "x-arcmeter-voucher: <token>" header line. */
export function decodeVoucher(input: string): Voucher | { error: string } {
  const token = input
    .trim()
    .replace(new RegExp(`^${VOUCHER_HEADER}\\s*:\\s*`, 'i'), '')
    .replace(/\s+/g, '')
  if (!token) return { error: 'Paste a voucher.' }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(token)))
    if (typeof parsed !== 'object' || parsed === null) return { error: 'Voucher is not a JSON object.' }
    const { c, a, s } = parsed as Record<string, unknown>
    if (typeof c !== 'string' || !HEX32.test(c)) return { error: 'Voucher channel id (c) is invalid.' }
    if (typeof a !== 'string' && typeof a !== 'number') return { error: 'Voucher amount (a) is invalid.' }
    if (typeof s !== 'string' || !HEX_BYTES.test(s)) return { error: 'Voucher signature (s) is invalid.' }
    const amount = BigInt(a)
    if (amount < 0n) return { error: 'Voucher amount (a) is negative.' }
    return { c: c as Hex, a: amount, s: s as Hex }
  } catch {
    return { error: 'Not a valid voucher. Expected base64url of {c, a, s}.' }
  }
}

const ERROR_TEXT: Record<string, string> = {
  ZeroAddress: 'An address was zero.',
  SelfPayment: 'The payee cannot be your own address.',
  ZeroAmount: 'Amount must be greater than zero.',
  InvalidExpiry: 'Expiry must be in the future.',
  ChannelNotFound: 'Channel not found. It may be closed or on another network.',
  NotPayee: 'Only the payee can do this. Switch to the payee account.',
  NotPayer: 'Only the payer can do this. Switch to the payer account.',
  NothingToClaim: 'Nothing to claim. This voucher is stale or already redeemed.',
  ExceedsDeposit: 'The voucher amount exceeds the channel deposit.',
  ChannelExpired: 'This channel has expired. Vouchers can no longer be redeemed.',
  ChannelNotExpired: 'The channel has not expired yet.',
  InvalidSignature: 'The voucher signature is not from the channel payer.',
  DepositOverflow: 'Deposit too large.',
}

/** Turn a viem/wagmi failure into one short human sentence. */
export function parseTxError(error: unknown): string | null {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('user rejected') || message.includes('user denied')) return null
  if (error instanceof BaseError) {
    let cursor: unknown = error
    while (cursor instanceof Error) {
      const named = cursor as Error & { data?: { errorName?: string }; errorName?: string }
      const name = named.data?.errorName ?? named.errorName
      if (name && ERROR_TEXT[name]) return ERROR_TEXT[name]
      cursor = (cursor as Error & { cause?: unknown }).cause
    }
  }
  if (message.includes('insufficient funds') || message.includes('exceeds balance')) {
    return 'Insufficient balance for this transaction.'
  }
  if (message.includes('network') || message.includes('timeout') || message.includes('fetch')) {
    return 'Network issue. Check your connection and retry.'
  }
  return 'Transaction failed. Please try again.'
}

export const shortHex = (value: string, head = 6, tail = 4) =>
  value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
