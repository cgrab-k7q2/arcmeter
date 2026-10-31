import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isHex, zeroAddress, type Address, type Hex } from 'viem'
import { arcMeterAbi } from '@/lib/arcmeter'
import { useMeter } from '@/context/MeterContext'

export interface ChannelData {
  id: Hex
  payer: Address
  payee: Address
  deposit: bigint
  claimed: bigint
  expiresAt: bigint
  remaining: bigint
}

export const isChannelId = (value: string): value is Hex => isHex(value) && value.length === 66

/** Reads channels(id). Resolves to null when the channel does not exist (closed or reclaimed). */
export function useChannel(id: string | undefined, enabledOverride = true) {
  const { publicClient, address, chainId } = useMeter()
  const valid = !!id && isChannelId(id)
  return useQuery({
    queryKey: ['channel', chainId, address, id],
    enabled: enabledOverride && valid && !!publicClient && !!address,
    refetchInterval: 8000,
    queryFn: async (): Promise<ChannelData | null> => {
      if (!publicClient || !address || !id || !isChannelId(id)) return null
      const [payer, payee, deposit, claimed, expiresAt] = await publicClient.readContract({
        address,
        abi: arcMeterAbi,
        functionName: 'channels',
        args: [id],
      })
      if (payer === zeroAddress) return null
      return { id, payer, payee, deposit, claimed, expiresAt: BigInt(expiresAt), remaining: deposit - claimed }
    },
  })
}

export function useRefreshChannels() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: ['channel'] })
}
