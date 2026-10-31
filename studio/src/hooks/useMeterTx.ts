import { useAccount, useWalletClient } from 'wagmi'
import type { Hash, PublicClient } from 'viem'
import { useMeter } from '@/context/MeterContext'

/** Wallet + public client for the selected chain, plus a receipt waiter that checks status. */
export function useMeterTx() {
  const { address: account } = useAccount()
  const { chainId, publicClient, address: meter } = useMeter()
  const { data: walletClient } = useWalletClient({ chainId: chainId })

  async function waitFor(client: PublicClient, hash: Hash) {
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('Transaction reverted')
    return receipt
  }

  return { account, walletClient, publicClient, meter, waitFor }
}
