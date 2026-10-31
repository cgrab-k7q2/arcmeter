import type { Address, Hash, Hex, PublicClient, WalletClient } from 'viem'
import { arcMeterAbi, decodeVoucher, type Voucher } from '../lib/arcmeter'
import { parseUsdc } from '../onchain-money'

export type RejectReason =
  | 'missing_voucher'
  | 'malformed_voucher'
  | 'channel_not_found'
  | 'wrong_payee'
  | 'channel_expiring'
  | 'insufficient_payment'
  | 'invalid_voucher'
  | 'verification_unavailable'

export interface CheckRejected {
  ok: false
  /** 402 for a payment problem, 503 when the chain could not be queried. */
  status: 402 | 503
  reason: RejectReason
  message: string
  channelId?: Hex
  /** Cumulative amount the next voucher must reach (base units). */
  required?: bigint
}

export interface CheckAccepted {
  ok: true
  channelId: Hex
  /** Cumulative amount of the accepted voucher. */
  cumulative: bigint
  /** Price charged for this call. */
  price: bigint
  /** What the contract would pay if this voucher were claimed now. */
  payable: bigint
  voucher: Voucher
}

export type CheckResult = CheckAccepted | CheckRejected

export interface Accepted {
  cumulative: bigint
  voucher: Voucher
}

/** Keeps the best voucher accepted per channel. Swap in a persistent store for production. */
export interface VoucherStore {
  get(id: Hex): Accepted | undefined
  set(id: Hex, value: Accepted): void
  delete(id: Hex): void
  entries(): Iterable<[Hex, Accepted]>
}

export function memoryStore(): VoucherStore {
  const map = new Map<string, [Hex, Accepted]>()
  return {
    get: (id) => map.get(id.toLowerCase())?.[1],
    set: (id, value) => void map.set(id.toLowerCase(), [id, value]),
    delete: (id) => void map.delete(id.toLowerCase()),
    entries: () => map.values(),
  }
}

export interface CreateGuardOptions {
  publicClient: PublicClient
  chainId: number
  /** ArcMeter contract address. */
  meter: Address
  /** The address that must be the channel payee (the account that will settle). */
  payee: Address
  /** Price per call: base units, or a decimal USDC string such as "0.001". */
  price: bigint | string
  /** Reject channels expiring within this many seconds, since they may not settle in time. Default 30. */
  expiryBuffer?: number
  store?: VoucherStore
  /** Unix seconds; override in tests. */
  now?: () => number
}

export interface SettleResult {
  /** Transaction hash, or null when there was nothing to settle. */
  hash: Hash | null
  /** Amount paid out by this settlement (base units). */
  amount: bigint
  closed: boolean
}

export function createMeterGuard(options: CreateGuardOptions) {
  const { publicClient, chainId, meter, payee } = options
  const price = typeof options.price === 'string' ? parseUsdc(options.price) : options.price
  const expiryBuffer = options.expiryBuffer ?? 30
  const store = options.store ?? memoryStore()
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))

  if (price <= 0n) throw new Error('price must be greater than zero')
  if (publicClient.chain && publicClient.chain.id !== chainId) {
    throw new Error(`publicClient is on chain ${publicClient.chain.id}, expected ${chainId}`)
  }

  const reject = (
    status: 402 | 503,
    reason: RejectReason,
    message: string,
    extra: Partial<Pick<CheckRejected, 'channelId' | 'required'>> = {},
  ): CheckRejected => ({ ok: false, status, reason, message, ...extra })

  /** What a client needs to know to pay this service. */
  const requirements = () => ({ chainId, meter, payee, price })

  /**
   * Validate the x-arcmeter-voucher header for one call. Accepts only a voucher that
   * raises the channel's authorized total by at least `price` over the last accepted
   * (or already claimed) amount, so replays and stale vouchers are rejected.
   */
  async function check(header: string | string[] | undefined): Promise<CheckResult> {
    const raw = Array.isArray(header) ? header[0] : header
    if (!raw || !raw.trim()) {
      return reject(402, 'missing_voucher', 'Payment required: send a voucher in the x-arcmeter-voucher header.')
    }
    const decoded = decodeVoucher(raw)
    if ('error' in decoded) return reject(402, 'malformed_voucher', decoded.error)
    const { c: channelId, a: cumulative, s } = decoded

    let channel: readonly [Address, Address, bigint, bigint, bigint]
    let redeem: readonly [boolean, bigint]
    try {
      const [ch, rd] = await Promise.all([
        publicClient.readContract({ address: meter, abi: arcMeterAbi, functionName: 'channels', args: [channelId] }),
        publicClient.readContract({
          address: meter,
          abi: arcMeterAbi,
          functionName: 'redeemable',
          args: [channelId, cumulative, s],
        }),
      ])
      channel = [ch[0], ch[1], ch[2], ch[3], BigInt(ch[4])]
      redeem = rd
    } catch {
      return reject(503, 'verification_unavailable', 'Could not verify the voucher onchain. Try again shortly.', { channelId })
    }

    const [payer, channelPayee, , claimed, expiresAt] = channel
    if (payer === '0x0000000000000000000000000000000000000000') {
      return reject(402, 'channel_not_found', 'Channel not found on this network.', { channelId })
    }
    if (channelPayee.toLowerCase() !== payee.toLowerCase()) {
      return reject(402, 'wrong_payee', 'This channel does not pay this service.', { channelId })
    }
    if (Number(expiresAt) - now() <= expiryBuffer) {
      return reject(402, 'channel_expiring', 'Channel is expired or about to expire. Open a new channel.', { channelId })
    }

    const known = store.get(channelId)?.cumulative ?? 0n
    const required = (known > claimed ? known : claimed) + price
    if (cumulative < required) {
      return reject(
        402,
        'insufficient_payment',
        `Voucher must authorize at least ${required} base units cumulative; got ${cumulative}.`,
        { channelId, required },
      )
    }
    if (!redeem[0]) {
      return reject(
        402,
        'invalid_voucher',
        'Voucher rejected: bad signature, amount above the deposit, or the channel cannot redeem it.',
        { channelId },
      )
    }

    // Re-check after the awaits so two concurrent requests cannot both spend one voucher.
    const latest = store.get(channelId)?.cumulative ?? 0n
    if (cumulative < latest + price) {
      return reject(402, 'insufficient_payment', 'Voucher was already used.', { channelId, required: latest + price })
    }
    store.set(channelId, { cumulative, voucher: decoded })
    return { ok: true, channelId, cumulative, price, payable: redeem[1], voucher: decoded }
  }

  /** Best voucher accepted so far for a channel (undefined if none). */
  const accepted = (channelId: Hex) => store.get(channelId)

  /** Channels with accepted vouchers that have not been closed yet. */
  const pending = () => [...store.entries()].map(([channelId, v]) => ({ channelId, cumulative: v.cumulative }))

  /**
   * Redeem the best accepted voucher as the payee. `close: false` claims and keeps the
   * channel open; `close: true` also settles, refunds the payer, and deletes the channel.
   * With no voucher, close still works (refunds the payer) and claim is a no-op.
   */
  async function settle(
    walletClient: WalletClient,
    channelId: Hex,
    { close = false }: { close?: boolean } = {},
  ): Promise<SettleResult> {
    const account = walletClient.account
    if (!account) throw new Error('walletClient has no account')
    if (account.address.toLowerCase() !== payee.toLowerCase()) {
      throw new Error('walletClient account is not the configured payee')
    }
    const best = store.get(channelId)
    const [chPayer, , , claimed] = await publicClient.readContract({
      address: meter,
      abi: arcMeterAbi,
      functionName: 'channels',
      args: [channelId],
    })
    if (chPayer === '0x0000000000000000000000000000000000000000') {
      store.delete(channelId)
      return { hash: null, amount: 0n, closed: false }
    }
    const amount = best && best.cumulative > claimed ? best.cumulative - claimed : 0n

    let hash: Hash
    if (close) {
      const { request } = await publicClient.simulateContract({
        account,
        address: meter,
        abi: arcMeterAbi,
        functionName: 'close',
        args: best ? [channelId, best.voucher.a, best.voucher.s] : [channelId, 0n, '0x'],
      })
      hash = await walletClient.writeContract(request)
    } else {
      if (!best || amount === 0n) return { hash: null, amount: 0n, closed: false }
      const { request } = await publicClient.simulateContract({
        account,
        address: meter,
        abi: arcMeterAbi,
        functionName: 'claim',
        args: [channelId, best.voucher.a, best.voucher.s],
      })
      hash = await walletClient.writeContract(request)
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`settlement reverted (${hash})`)
    if (close) store.delete(channelId)
    return { hash, amount, closed: close }
  }

  return { requirements, check, accepted, pending, settle }
}

export type MeterGuard = ReturnType<typeof createMeterGuard>
