/**
 * Offline self-test for the ArcMeter SDK (`bun run demo:selftest`). Uses an in-memory fake
 * chain that verifies EIP-712 signatures like the contract does, so it needs no network or keys.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { verifyTypedData, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { voucherDomain, voucherTypes } from '../../src/lib/arcmeter'
import { createMeterGuard, createPayer, meterMiddleware, type MeterRequest } from '../../src/sdk'

const CHAIN_ID = 5042002
const METER: Address = '0x00000000000000000000000000000000000a1c0e'
const ID: Hex = `0x${'11'.repeat(32)}`
const OTHER_ID: Hex = `0x${'22'.repeat(32)}`
const ZERO: Address = '0x0000000000000000000000000000000000000000'

const payerAcct = privateKeyToAccount(generatePrivateKey())
const payeeAcct = privateKeyToAccount(generatePrivateKey())
const strangerAcct = privateKeyToAccount(generatePrivateKey())

let time = 1_000_000
const chain = {
  payer: payerAcct.address,
  payee: payeeAcct.address,
  deposit: 10_000n,
  claimed: 0n,
  expiresAt: BigInt(time + 3600),
  open: true,
  down: false,
}
const writes: { fn: string; args: readonly unknown[] }[] = []

const publicClient = {
  chain: { id: CHAIN_ID },
  readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    if (chain.down) throw new Error('rpc down')
    const id = args[0] as Hex
    const exists = chain.open && id === ID
    if (functionName === 'channels') {
      return exists
        ? [chain.payer, chain.payee, chain.deposit, chain.claimed, chain.expiresAt]
        : [ZERO, ZERO, 0n, 0n, 0n]
    }
    if (functionName === 'redeemable') {
      const cum = args[1] as bigint
      if (!exists || cum <= chain.claimed || cum > chain.deposit) return [false, 0n]
      const ok = await verifyTypedData({
        address: chain.payer,
        domain: voucherDomain(CHAIN_ID, METER),
        types: voucherTypes,
        primaryType: 'Voucher',
        message: { channelId: id, cumulativeAmount: cum },
        signature: args[2] as Hex,
      }).catch(() => false)
      return ok ? [true, cum - chain.claimed] : [false, 0n]
    }
    throw new Error(`unexpected read ${functionName}`)
  },
  simulateContract: (p: { functionName: string; args: readonly unknown[] }) => Promise.resolve({ request: p }),
  waitForTransactionReceipt: () => Promise.resolve({ status: 'success' }),
} as unknown as PublicClient

const walletFor = (address: Address) =>
  ({
    account: { address },
    writeContract: (req: { functionName: string; args: readonly unknown[] }) => {
      writes.push({ fn: req.functionName, args: req.args })
      if (req.functionName === 'claim') chain.claimed = req.args[1] as bigint
      if (req.functionName === 'close') chain.open = false
      return Promise.resolve('0xabc')
    },
  }) as unknown as WalletClient

const newGuard = (extra: { price?: string } = {}) =>
  createMeterGuard({ publicClient, chainId: CHAIN_ID, meter: METER, payee: chain.payee, price: extra.price ?? '0.001', now: () => time })
const newPayer = (id: Hex = ID, opts: { limit?: bigint } = {}) =>
  createPayer({ account: payerAcct, chainId: CHAIN_ID, meter: METER, channelId: id, ...opts })

let passed = 0
const test = async (name: string, fn: () => Promise<void>) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

await test('payer: cumulative is monotonic, concurrent pays are serialized', async () => {
  const payer = newPayer()
  const all = await Promise.all([payer.pay('0.001'), payer.pay(1000n), payer.pay('0.001')])
  assert.deepEqual(all.map((p) => p.cumulative), [1000n, 2000n, 3000n])
  assert.equal(payer.cumulative, 3000n)
  await assert.rejects(() => payer.pay(0n))
})

await test('payer: limit stops over-signing without advancing the counter', async () => {
  const payer = newPayer(ID, { limit: 1500n })
  await payer.pay(1000n)
  await assert.rejects(() => payer.pay(1000n), /exceed/)
  assert.equal(payer.cumulative, 1000n)
})

await test('guard: rejection reasons', async () => {
  const guard = newGuard()
  const payer = newPayer()
  const good = (await payer.pay(1000n)).header

  const r = async (h: string | undefined, g = guard) => {
    const res = await g.check(h)
    assert.equal(res.ok, false)
    return res.ok ? null : res
  }
  assert.equal((await r(undefined))?.reason, 'missing_voucher')
  assert.equal((await r('not-a-voucher!!'))?.reason, 'malformed_voucher')

  const unknown = await newPayer(OTHER_ID).pay(1000n)
  assert.equal((await r(unknown.header))?.reason, 'channel_not_found')

  const foreign = createPayer({ account: strangerAcct, chainId: CHAIN_ID, meter: METER, channelId: ID })
  assert.equal((await r((await foreign.pay(1000n)).header))?.reason, 'invalid_voucher')

  const tooMuch = await newPayer().pay(20_000n)
  assert.equal((await r(tooMuch.header))?.reason, 'invalid_voucher')

  const wrongPayee = createMeterGuard({ publicClient, chainId: CHAIN_ID, meter: METER, payee: strangerAcct.address, price: '0.001', now: () => time })
  assert.equal((await r(good, wrongPayee))?.reason, 'wrong_payee')

  chain.down = true
  assert.equal((await r(good))?.status, 503)
  chain.down = false

  time = Number(chain.expiresAt) - 10
  assert.equal((await r(good))?.reason, 'channel_expiring')
  time = 1_000_000
})

await test('guard: accepts, then rejects replays and underpayment', async () => {
  const guard = newGuard()
  const payer = newPayer()
  const first = await payer.pay(1000n)
  const ok1 = await guard.check(first.header)
  assert.ok(ok1.ok && ok1.cumulative === 1000n && ok1.payable === 1000n)

  const replay = await guard.check(first.header)
  assert.ok(!replay.ok && replay.reason === 'insufficient_payment' && replay.required === 2000n)

  const cheap = await payer.pay(500n) // 1500 < 1000 + price
  const underpaid = await guard.check(cheap.header)
  assert.ok(!underpaid.ok && underpaid.reason === 'insufficient_payment')

  const next = await payer.pay(500n) // 2000
  assert.ok((await guard.check(next.header)).ok)
})

await test('guard: concurrent use of one voucher is accepted once', async () => {
  const guard = newGuard()
  const v = await newPayer().pay(1000n)
  const results = await Promise.all([guard.check(v.header), guard.check(v.header), guard.check(v.header)])
  assert.equal(results.filter((x) => x.ok).length, 1)
})

await test('middleware + payer.fetch over real HTTP, 402 rollback', async () => {
  const guard = newGuard()
  const paywall = meterMiddleware(guard)
  const server = createServer((req: MeterRequest, res) => {
    void paywall(req, res).then((ok) => {
      if (ok) res.end(JSON.stringify({ hello: 'paid', accepted: req.arcmeter?.cumulative.toString() }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const url = `http://127.0.0.1:${addr.port}/`

  const bare = await fetch(url)
  assert.equal(bare.status, 402)
  assert.equal(bare.headers.get('x-arcmeter-price'), '1000')
  assert.equal(bare.headers.get('x-arcmeter-payee')?.toLowerCase(), chain.payee.toLowerCase())

  const payer = newPayer()
  for (let i = 1; i <= 3; i++) {
    const res = await payer.fetch(url, undefined, '0.001')
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { accepted: string }).accepted, String(i * 1000))
  }

  // Server restarts with a payee mismatch: 402s must not advance the payer's counter.
  chain.open = false
  const before = payer.cumulative
  const rejected = await payer.fetch(url, undefined, '0.001')
  assert.equal(rejected.status, 402)
  await Promise.resolve()
  assert.equal(payer.cumulative, before)
  chain.open = true
  server.close()
})

await test('settle: claim keeps the channel open, close deletes it, non-payee refused', async () => {
  chain.claimed = 0n
  chain.open = true
  const guard = newGuard()
  const payer = newPayer()
  await guard.check((await payer.pay(1000n)).header)
  await guard.check((await payer.pay(1000n)).header)

  await assert.rejects(() => guard.settle(walletFor(strangerAcct.address), ID), /not the configured payee/)

  writes.length = 0
  const claimed = await guard.settle(walletFor(chain.payee), ID)
  assert.equal(claimed.amount, 2000n)
  assert.equal(writes[0]?.fn, 'claim')
  assert.equal(chain.open, true)

  const nothing = await guard.settle(walletFor(chain.payee), ID)
  assert.equal(nothing.hash, null)

  await guard.check((await payer.pay(1000n)).header)
  const closed = await guard.settle(walletFor(chain.payee), ID, { close: true })
  assert.equal(closed.amount, 1000n)
  assert.equal(writes[1]?.fn, 'close')
  assert.equal(chain.open, false)
  assert.equal(guard.pending().length, 0)
})

console.log(`\n${passed} groups passed`)
