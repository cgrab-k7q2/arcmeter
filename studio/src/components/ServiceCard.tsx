import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ServerCog } from 'lucide-react'
import type { Hash, Hex } from 'viem'
import { arcMeterAbi, decodeVoucher, parseTxError, shortHex } from '@/lib/arcmeter'
import { formatUsdc } from '@/onchain-money'
import { useMeter } from '@/context/MeterContext'
import { isChannelId, useChannel, useRefreshChannels } from '@/hooks/useChannel'
import { useMeterTx } from '@/hooks/useMeterTx'
import { ActionButton, Card, ExplorerLink, Field, Notice, Row } from './ui'

type Action = 'claim' | 'close' | 'closeEmpty'

export function ServiceCard() {
  const { channelId, chainId, publicClient, address } = useMeter()
  const { account, walletClient, meter, waitFor } = useMeterTx()
  const refresh = useRefreshChannels()

  const [input, setInput] = useState('')
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ label: string; hash: Hash } | null>(null)

  const decoded = useMemo(() => (input.trim() ? decodeVoucher(input) : null), [input])
  const voucher = decoded && !('error' in decoded) ? decoded : null

  const { data: channel } = useChannel(voucher?.c ?? (isChannelId(channelId) ? channelId : undefined))

  const redeem = useQuery({
    queryKey: ['redeemable', chainId, address, voucher?.c, voucher?.a.toString(), voucher?.s],
    enabled: !!voucher && !!publicClient && !!address,
    refetchInterval: 8000,
    queryFn: async () => {
      if (!voucher || !publicClient || !address) return null
      const [ok, amount] = await publicClient.readContract({
        address,
        abi: arcMeterAbi,
        functionName: 'redeemable',
        args: [voucher.c, voucher.a, voucher.s],
      })
      return { ok, amount }
    },
  })

  const isPayee = !!channel && !!account && channel.payee.toLowerCase() === account.toLowerCase()
  const closeTarget: Hex | null = voucher?.c ?? (isChannelId(channelId) ? channelId : null)

  async function run(action: Action) {
    if (!publicClient || !walletClient || !account || !meter) return
    setBusy(action)
    setError(null)
    setDone(null)
    try {
      let hash: Hash
      if (action === 'claim') {
        if (!voucher) return
        const { request } = await publicClient.simulateContract({
          account,
          address: meter,
          abi: arcMeterAbi,
          functionName: 'claim',
          args: [voucher.c, voucher.a, voucher.s],
        })
        hash = await walletClient.writeContract(request)
      } else if (action === 'close') {
        if (!voucher) return
        const { request } = await publicClient.simulateContract({
          account,
          address: meter,
          abi: arcMeterAbi,
          functionName: 'close',
          args: [voucher.c, voucher.a, voucher.s],
        })
        hash = await walletClient.writeContract(request)
      } else {
        if (!closeTarget) return
        const { request } = await publicClient.simulateContract({
          account,
          address: meter,
          abi: arcMeterAbi,
          functionName: 'close',
          args: [closeTarget, 0n, '0x'],
        })
        hash = await walletClient.writeContract(request)
      }
      await waitFor(publicClient, hash)
      setDone({
        label:
          action === 'claim'
            ? `Claimed ${redeem.data ? formatUsdc(redeem.data.amount) : ''} USDC. The channel stays open.`
            : 'Channel closed and the remainder refunded to the payer.',
        hash,
      })
      void refresh()
      void redeem.refetch()
    } catch (e) {
      setError(parseTxError(e))
    } finally {
      setBusy(null)
    }
  }

  const payeeNotice = channel && account && !isPayee ? 'Connect the payee account to claim or close.' : null
  const anyBusy = busy !== null

  return (
    <Card
      step="3 · Payee"
      title="Service"
      subtitle="Paste the voucher from a request, verify it onchain, then claim or close."
      icon={<ServerCog className="size-5" />}
    >
      <Field label="Voucher (x-arcmeter-voucher)">
        <textarea
          className="field mono min-h-24 resize-y text-xs"
          placeholder="eyJjIjoiMHg…"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setDone(null)
            setError(null)
          }}
          spellCheck={false}
        />
      </Field>

      {decoded && 'error' in decoded && <Notice tone="error">{decoded.error}</Notice>}

      {voucher && (
        <>
          <dl className="divide-y rounded-2xl px-4" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)' }}>
            <Row label="Channel" value={shortHex(voucher.c, 10, 6)} mono />
            <Row label="Cumulative" value={`${formatUsdc(voucher.a)} USDC`} />
            <Row
              label="Redeemable now"
              value={
                redeem.isLoading ? (
                  'Checking…'
                ) : redeem.isError ? (
                  'Could not check'
                ) : redeem.data?.ok ? (
                  <span style={{ color: 'var(--success)' }}>{formatUsdc(redeem.data.amount)} USDC</span>
                ) : (
                  <span style={{ color: 'var(--danger)' }}>Not redeemable</span>
                )
              }
            />
          </dl>
          {redeem.data && !redeem.data.ok && (
            <Notice tone="error">
              Rejected by the contract: the signature is invalid, the voucher is stale or over the deposit, the channel is expired or closed, or it belongs to another network.
            </Notice>
          )}
          {redeem.data?.ok && <Notice tone="success">Valid. The contract would pay {formatUsdc(redeem.data.amount)} USDC to the payee.</Notice>}
        </>
      )}

      {payeeNotice && <Notice tone="info">{payeeNotice}</Notice>}

      <div className="grid grid-cols-2 gap-3">
        <ActionButton
          label="Claim"
          busy={busy === 'claim'}
          busyLabel="Claiming…"
          disabled={!voucher || !redeem.data?.ok || !isPayee || anyBusy}
          onClick={() => run('claim')}
        />
        <ActionButton
          variant="ghost"
          label="Close with voucher"
          busy={busy === 'close'}
          busyLabel="Closing…"
          disabled={!voucher || !isPayee || anyBusy}
          onClick={() => run('close')}
        />
      </div>
      <ActionButton
        variant="ghost"
        label="Close without a voucher"
        busy={busy === 'closeEmpty'}
        busyLabel="Closing…"
        disabled={!closeTarget || !isPayee || anyBusy}
        onClick={() => run('closeEmpty')}
      />
      <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
        Claim pays the new amount and keeps the channel open. Close pays any new amount, refunds the rest to the payer, and deletes the channel.
      </p>

      {error && <Notice tone="error">{error}</Notice>}
      {done && (
        <div className="space-y-2">
          <Notice tone="success">{done.label}</Notice>
          <ExplorerLink kind="tx" value={done.hash} label="View transaction" />
        </div>
      )}
    </Card>
  )
}
