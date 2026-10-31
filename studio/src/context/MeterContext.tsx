import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { isAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { APP_CHAINS, chainById, envAddressFor, type AppChain, type AppChainId } from '@/lib/chains'
import { useLocalStorage } from '@/hooks/useLocalStorage'

interface MeterState {
  chain: AppChain
  chainId: AppChainId
  setChainId: (id: number) => void
  /** Resolved ArcMeter address for the selected chain (runtime override, else env). */
  address: Address | undefined
  addressOverride: string
  setAddressOverride: (value: string) => void
  /** Active channel shared by the Open, Pay, Service and Status cards. */
  channelId: string
  setChannelId: (id: string) => void
  publicClient: PublicClient | undefined
}

const MeterContext = createContext<MeterState | null>(null)

export function MeterProvider({ children }: { children: ReactNode }) {
  const [storedChain, setStoredChain] = useLocalStorage('arcmeter:chain', String(APP_CHAINS[0].id))
  const chain = useMemo(() => {
    const found = APP_CHAINS.find((c) => String(c.id) === storedChain)
    return found ?? chainById(APP_CHAINS[0].id)
  }, [storedChain])

  const [addressOverride, setAddressOverride] = useLocalStorage(`arcmeter:address:${chain.id}`)
  const [channelId, setChannelId] = useLocalStorage(`arcmeter:channel:${chain.id}`)

  const address = useMemo<Address | undefined>(() => {
    const trimmed = addressOverride.trim()
    return isAddress(trimmed) ? trimmed : envAddressFor(chain.id)
  }, [addressOverride, chain.id])

  const publicClient = usePublicClient({ chainId: chain.id }) as
    | PublicClient
    | undefined

  const value = useMemo<MeterState>(
    () => ({
      chain,
      chainId: chain.id,
      setChainId: (id) => setStoredChain(String(id)),
      address,
      addressOverride,
      setAddressOverride,
      channelId,
      setChannelId,
      publicClient,
    }),
    [chain, address, addressOverride, setAddressOverride, channelId, setChannelId, setStoredChain, publicClient],
  )

  return <MeterContext.Provider value={value}>{children}</MeterContext.Provider>
}

export function useMeter(): MeterState {
  const ctx = useContext(MeterContext)
  if (!ctx) throw new Error('useMeter must be used inside MeterProvider')
  return ctx
}
