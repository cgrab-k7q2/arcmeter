import type { Address, Hex, LocalAccount } from 'viem'
import {
  encodeVoucher,
  VOUCHER_HEADER,
  voucherDomain,
  voucherTypes,
  type Voucher,
} from '../lib/arcmeter'
import { parseUsdc } from '../onchain-money'

export interface Payment {
  /** base64url voucher token, ready for the x-arcmeter-voucher header */
  header: string
  voucher: Voucher
  /** lifetime amount this voucher authorizes, USDC base units */
  cumulative: bigint
  /** lifetime amount before this payment */
  previous: bigint
}

export interface CreatePayerOptions {
  /** Payer account that owns the channel (a viem local account or any object with signTypedData). */
  account: Pick<LocalAccount, 'address' | 'signTypedData'>
  chainId: number
  /** ArcMeter contract address (the EIP-712 verifyingContract). */
  meter: Address
  channelId: Hex
  /** Resume from a previously signed cumulative amount (base units). Default 0. */
  cumulative?: bigint
  /** Refuse to sign beyond this lifetime amount, e.g. the channel deposit (base units). */
  limit?: bigint
  /** fetch implementation, defaults to the global one. */
  fetch?: typeof globalThis.fetch
}

/**
 * Signs cumulative vouchers for one channel. Amounts are USDC base units (bigint) or a
 * decimal USDC string such as "0.001". Calls are serialized so the cumulative amount
 * only ever increases.
 */
export function createPayer(options: CreatePayerOptions) {
  const { account, chainId, meter, channelId, limit } = options
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  let total = options.cumulative ?? 0n
  let queue: Promise<unknown> = Promise.resolve()

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  const toBase = (amount: bigint | string): bigint => {
    const value = typeof amount === 'string' ? parseUsdc(amount) : amount
    if (value <= 0n) throw new Error('Payment amount must be greater than zero')
    return value
  }

  /** Sign a voucher that raises the lifetime total by `amount`. */
  function pay(amount: bigint | string): Promise<Payment> {
    return serialize(async () => {
      const delta = toBase(amount)
      const previous = total
      const next = previous + delta
      if (limit !== undefined && next > limit) {
        throw new Error(`Payment would exceed the channel limit (${next} > ${limit})`)
      }
      const s = await account.signTypedData({
        domain: voucherDomain(chainId, meter),
        types: voucherTypes,
        primaryType: 'Voucher',
        message: { channelId, cumulativeAmount: next },
      })
      const voucher: Voucher = { c: channelId, a: next, s }
      total = next
      return { header: encodeVoucher(voucher), voucher, cumulative: next, previous }
    })
  }

  /**
   * fetch() with a fresh voucher worth `price` attached as x-arcmeter-voucher. If the
   * server answers 402 the payment was not accepted, so the counter is rolled back and
   * the same cumulative amount can be signed again.
   */
  async function paidFetch(url: string | URL, init: RequestInit | undefined, price: bigint | string): Promise<Response> {
    const payment = await pay(price)
    const headers = new Headers(init?.headers)
    headers.set(VOUCHER_HEADER, payment.header)
    const response = await fetchImpl(url, { ...init, headers })
    if (response.status === 402) {
      void serialize(() => {
        if (total === payment.cumulative) total = payment.previous
        return Promise.resolve()
      })
    }
    return response
  }

  return {
    channelId,
    pay,
    fetch: paidFetch,
    /** Lifetime amount signed so far (base units). */
    get cumulative() {
      return total
    },
  }
}

export type Payer = ReturnType<typeof createPayer>
