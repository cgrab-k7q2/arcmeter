import { createPublicClient, createWalletClient, http, isAddress, isHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import { requireChain } from '../../src/onchain-facts'

/** Demo runs on Arc Testnet. */
export const CHAIN = arcTestnet
export const CHAIN_KEY = 'Arc_Testnet'

/** Keyed RPC proxy when Arc Studio provisions one for this chain, else the public RPC from the facts registry. */
export function rpcUrl(): string {
  const base = process.env.RPC_PROXY_BASE_URL
  const token = process.env.RPC_PROXY_TOKEN
  const chains = (process.env.RPC_PROXY_CHAINS || '').split(',')
  if (base && token && chains.includes(CHAIN_KEY)) {
    return `${base}/api/rpc/${CHAIN_KEY}?_rpc_token=${token}`
  }
  return requireChain(CHAIN.id).rpcUrls[0]
}

export function meterAddress(): Address {
  const value = process.env[`VITE_ARCMETER_ADDRESS_${CHAIN.id}`]
  if (!value || !isAddress(value)) {
    throw new Error(`Set VITE_ARCMETER_ADDRESS_${CHAIN.id} in .env to the deployed ArcMeter address.`)
  }
  return value
}

export function privateKey(name: string): Hex {
  const value = process.env[name]
  if (!value || !isHex(value) || value.length !== 66) {
    throw new Error(`${name} is missing. Run: bun run demo:setup`)
  }
  return value
}

export function makeClients(keyName: string) {
  const account = privateKeyToAccount(privateKey(keyName))
  const transport = http(rpcUrl())
  return {
    account,
    publicClient: createPublicClient({ chain: CHAIN, transport }),
    walletClient: createWalletClient({ account, chain: CHAIN, transport }),
  }
}

export const explorerTx = (hash: string) => `${requireChain(CHAIN.id).explorerBase}/tx/${hash}`
