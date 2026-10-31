/**
 * Demo agent: discovers the price from a 402, opens a channel, then makes 3 paid calls.
 * Standalone: `bun run demo:agent` (server must be running on DEMO_API_URL, default :8402).
 */
import { erc20Abi, isAddress, parseEventLogs, type Address, type Hex } from 'viem'
import { arcMeterAbi } from '../../src/lib/arcmeter'
import { formatUsdc, parseUsdc } from '../../src/onchain-money'
import { createPayer } from '../../src/sdk'
import { CHAIN, explorerTx, makeClients, meterAddress } from './shared'

interface Requirements {
  payee: Address
  price: bigint
  meter: Address
  chainId: number
}

async function discover(url: string): Promise<Requirements> {
  const res = await fetch(url)
  if (res.status !== 402) throw new Error(`Expected 402 from ${url}, got ${res.status}`)
  const body = (await res.json()) as Record<string, unknown>
  const { payee, meter, price, chainId } = body
  if (typeof payee !== 'string' || !isAddress(payee) || typeof meter !== 'string' || !isAddress(meter)) {
    throw new Error('402 response is missing payee/meter')
  }
  if (typeof price !== 'string' || typeof chainId !== 'number') throw new Error('402 response is missing price/chainId')
  return { payee, meter, price: BigInt(price), chainId }
}

export async function runAgent(baseUrl: string) {
  const { account, publicClient, walletClient } = makeClients('DEMO_PAYER_PRIVATE_KEY')
  const meter = meterAddress()
  const target = `${baseUrl}/api/haiku`

  console.log(`[agent] payer ${account.address}`)
  const need = await discover(target)
  if (need.chainId !== CHAIN.id || need.meter.toLowerCase() !== meter.toLowerCase()) {
    throw new Error('Service wants a different chain or ArcMeter contract than this agent is configured for')
  }
  console.log(`[agent] service wants ${formatUsdc(need.price)} USDC per call, pays out to ${need.payee}`)

  const token = await publicClient.readContract({ address: meter, abi: arcMeterAbi, functionName: 'usdc' })
  const deposit = parseUsdc(process.env.DEMO_DEPOSIT ?? '0.01')
  const balance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (balance < deposit) {
    throw new Error(`Payer has ${formatUsdc(balance)} USDC, needs ${formatUsdc(deposit)}. Fund ${account.address} first.`)
  }

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, meter],
  })
  if (allowance < deposit) {
    const { request } = await publicClient.simulateContract({
      account,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [meter, deposit],
    })
    const hash = await walletClient.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`[agent] approved ${formatUsdc(deposit)} USDC ${explorerTx(hash)}`)
  }

  const block = await publicClient.getBlock()
  const { request } = await publicClient.simulateContract({
    account,
    address: meter,
    abi: arcMeterAbi,
    functionName: 'open',
    args: [need.payee, deposit, block.timestamp + 3600n],
  })
  const openHash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: openHash })
  const [opened] = parseEventLogs({ abi: arcMeterAbi, eventName: 'ChannelOpened', logs: receipt.logs })
  if (!opened) throw new Error('ChannelOpened event not found')
  const channelId: Hex = opened.args.id
  console.log(`[agent] opened channel ${channelId} ${explorerTx(openHash)}`)

  const payer = createPayer({ account, chainId: CHAIN.id, meter, channelId, limit: deposit })
  for (let i = 1; i <= 3; i++) {
    const res = await payer.fetch(target, undefined, need.price)
    if (!res.ok) throw new Error(`Call ${i} failed with ${res.status}: ${await res.text()}`)
    const { haiku } = (await res.json()) as { haiku: string }
    console.log(`[agent] call ${i} paid, total authorized ${formatUsdc(payer.cumulative)} USDC\n${haiku}\n`)
  }
  return { channelId, cumulative: payer.cumulative }
}
