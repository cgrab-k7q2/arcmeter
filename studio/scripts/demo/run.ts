/** End-to-end demo: paid API + agent in one process, then the payee closes the channel. `bun run demo`. */
import { erc20Abi } from 'viem'
import { arcMeterAbi } from '../../src/lib/arcmeter'
import { formatUsdc } from '../../src/onchain-money'
import { runAgent } from './agent'
import { settleAll, startServer } from './server'
import { makeClients, meterAddress } from './shared'

const payee = makeClients('DEMO_PAYEE_PRIVATE_KEY')
const meter = meterAddress()
const token = await payee.publicClient.readContract({ address: meter, abi: arcMeterAbi, functionName: 'usdc' })
const balanceOf = () =>
  payee.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [payee.account.address] })

const demo = await startServer({ publicClient: payee.publicClient, payee: payee.account.address })
console.log(`[api] listening on ${demo.url}, payee ${payee.account.address}`)

try {
  const before = await balanceOf()
  const { channelId } = await runAgent(demo.url)
  await settleAll(demo, payee.walletClient, true)
  const after = await balanceOf()
  const [chPayer] = await payee.publicClient.readContract({
    address: meter,
    abi: arcMeterAbi,
    functionName: 'channels',
    args: [channelId],
  })
  console.log(`[done] payee balance ${formatUsdc(before)} -> ${formatUsdc(after)} USDC (net of gas)`)
  console.log(`[done] channel deleted: ${chPayer === '0x0000000000000000000000000000000000000000'}`)
} finally {
  await demo.close()
}
