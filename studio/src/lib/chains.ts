import { arcTestnet } from 'viem/chains'
import type { Address, Chain } from 'viem'
import { isAddress } from 'viem'

/**
 * Chains ArcMeter can run on. Add a chain here (and its address env var) to enable it.
 * The contract address for chain N comes from VITE_ARCMETER_ADDRESS_N, and can be
 * overridden at runtime from the Contract settings in the header.
 */
export const APP_CHAINS = [arcTestnet] as const satisfies readonly [Chain, ...Chain[]]

export type AppChain = (typeof APP_CHAINS)[number]
export type AppChainId = AppChain['id']

export function envAddressFor(chainId: number): Address | undefined {
  const env = import.meta.env as Record<string, string | undefined>
  const value = env[`VITE_ARCMETER_ADDRESS_${chainId}`]
  return value && isAddress(value) ? value : undefined
}

export function chainById(chainId: number): AppChain {
  const found = APP_CHAINS.find((c) => c.id === chainId)
  if (!found) throw new Error(`Unsupported chain ${chainId}`)
  return found
}

export function explorerBase(chain: Chain): string {
  return chain.blockExplorers?.default.url ?? ''
}
