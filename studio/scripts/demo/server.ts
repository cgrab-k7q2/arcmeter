/**
 * Demo paid API. Free route: GET /free/health. Paid routes (0.001 USDC per call):
 * GET /api/haiku. Start it standalone with `bun run demo:server`.
 */
import { createServer, type Server } from 'node:http'
import type { Address, PublicClient, WalletClient } from 'viem'
import { createMeterGuard, meterMiddleware, type MeterRequest } from '../../src/sdk'
import { formatUsdc } from '../../src/onchain-money'
import { CHAIN, explorerTx, meterAddress } from './shared'

export const PRICE = '0.001'

const HAIKU = [
  'Channel stays open wide,\nvouchers rise like morning tide,\nonly deltas move.',
  'One signature signed,\ncumulative, never less,\nstale ones fall away.',
  'Gas is dollars here,\nsub-second finality hums,\ncalls are paid in full.',
]

export interface DemoServer {
  server: Server
  url: string
  guard: ReturnType<typeof createMeterGuard>
  close: () => Promise<void>
}

export async function startServer(opts: {
  publicClient: PublicClient
  payee: Address
  port?: number
}): Promise<DemoServer> {
  const guard = createMeterGuard({
    publicClient: opts.publicClient,
    chainId: CHAIN.id,
    meter: meterAddress(),
    payee: opts.payee,
    price: PRICE,
  })
  const paywall = meterMiddleware(guard, {
    onPaid: (p) => console.log(`[api] accepted voucher: cumulative ${formatUsdc(p.cumulative)} USDC`),
  })

  let served = 0
  const server = createServer((req: MeterRequest, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/free/health') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (path === '/api/haiku') {
        if (!(await paywall(req, res))) return
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ haiku: HAIKU[served++ % HAIKU.length], paid: PRICE }))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })().catch(() => {
      res.statusCode = 500
      res.end('server error')
    })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  return {
    server,
    guard,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Claim (and optionally close) every channel that has accepted vouchers. */
export async function settleAll(demo: DemoServer, walletClient: WalletClient, close: boolean) {
  for (const { channelId } of demo.guard.pending()) {
    const result = await demo.guard.settle(walletClient, channelId, { close })
    if (result.hash) {
      console.log(
        `[settle] ${close ? 'closed' : 'claimed'} ${channelId.slice(0, 10)}…: ${formatUsdc(result.amount)} USDC ${explorerTx(result.hash)}`,
      )
    }
  }
}
