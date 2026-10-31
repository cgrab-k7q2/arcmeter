/**
 * Creates throwaway testnet keys for the demo payer and payee and appends them to .env.
 * Keys are never printed. Testnet only: do not reuse these keys anywhere with real funds.
 */
import { appendFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isHex } from 'viem'

const lines: string[] = []
const addresses: Record<string, string> = {}

for (const name of ['DEMO_PAYER_PRIVATE_KEY', 'DEMO_PAYEE_PRIVATE_KEY']) {
  const existing = process.env[name]
  const key = existing && isHex(existing) ? existing : generatePrivateKey()
  if (!existing) lines.push(`${name}=${key}`)
  addresses[name] = privateKeyToAccount(key).address
}

if (lines.length) appendFileSync('.env', `\n# Demo testnet keys (bun run demo:setup)\n${lines.join('\n')}\n`)

console.log(lines.length ? `Added ${lines.length} key(s) to .env.` : 'Demo keys already in .env.')
console.log(`Payer (needs USDC for the deposit and gas): ${addresses.DEMO_PAYER_PRIVATE_KEY}`)
console.log(`Payee (needs a little USDC for gas):        ${addresses.DEMO_PAYEE_PRIVATE_KEY}`)
