/** Standalone paid API: `bun run demo:server`. Ctrl+C claims what the payee earned. */
import { makeClients } from './shared'
import { PRICE, settleAll, startServer } from './server'

const { account, publicClient, walletClient } = makeClients('DEMO_PAYEE_PRIVATE_KEY')
const demo = await startServer({ publicClient, payee: account.address, port: 8402 })
console.log(`Paid API on ${demo.url}  (payee ${account.address}, ${PRICE} USDC per call)`)

process.on('SIGINT', () => {
  settleAll(demo, walletClient, false)
    .catch((e: unknown) => console.error('settle failed:', e instanceof Error ? e.message : e))
    .finally(() => process.exit(0))
})
