import { useState } from 'react'
import { Gauge } from 'lucide-react'
import type { Hash } from 'viem'
import { arcMeterAbi, parseTxError, shortHex } from '@/lib/arcmeter'
import { formatUsdc } from '@/onchain-money'
import { timeLeft } from '@/lib/time'
import { useMeter } from '@/context/MeterContext'
import { isChannelId, useChannel, useRefreshChannels } from '@/hooks/useChannel'
import { useMeterTx } from '@/hooks/useMeterTx'
import { useNowSec } from '@/hooks/useNowSec'
import { ActionButton, Card, ExplorerLink, Field, Notice, Row } from './ui'

export function StatusCard() {
  const { channelId, setChannelId } = useMeter()
  const { account, walletClient, publicClient, meter, waitFor } = useMeterTx()
  const { data: channel, isLoading, isError } = useChannel(channelId)
  const refresh = useRefreshChannels()
  const now = useNowSec()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reclaimed, setReclaimed] = useState<Hash | null>(null)

  const expired = channel ? BigInt(now) >= channel.expiresAt : false
  const isPayer = !!channel && !!account && channel.payer.toLowerCase() === account.toLowerCase()
  const pct = channel && channel.deposit > 0n ? Number((channel.claimed * 10000n) / channel.deposit) / 100 : 0

  async function onReclaim() {
    if (!channel || !publicClient || !walletClient || !account || !meter) return
    setBusy(true)
    setError(null)
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: meter,
        abi: arcMeterAbi,
        functionName: 'reclaim',
        args: [channel.id],
      })
      const hash = await walletClient.writeContract(request)
      await waitFor(publicClient, hash)
      setReclaimed(hash)
      void refresh()
    } catch (e) {
      setError(parseTxError(e))
    } finally {
      setBusy(false)
    }
  }

  const reclaimHint = !channel
    ? ''
    : !isPayer
      ? 'Connect the payer account to reclaim.'
      : !expired
        ? `Available after expiry (${timeLeft(channel.expiresAt, now)} left).`
        : `Returns ${formatUsdc(channel.remaining)} USDC to the payer.`

  return (
    <Card
      step="4 · Status"
      title="Channel status"
      subtitle="Live state from the contract. Reclaim unspent funds after expiry."
      icon={<Gauge className="size-5" />}
    >
      <Field label="Channel id">
        <input
          className="field mono text-xs"
          placeholder="0x… (opened channels appear here)"
          value={channelId}
          onChange={(e) => {
            setChannelId(e.target.value.trim())
            setReclaimed(null)
            setError(null)
          }}
          spellCheck={false}
        />
      </Field>

      {!channelId && <Notice tone="info">Open a channel or paste an id to see its status.</Notice>}
      {channelId && !isChannelId(channelId) && <Notice tone="error">A channel id is 32 bytes of hex (0x + 64 characters).</Notice>}
      {isLoading && <p className="text-sm" style={{ color: 'var(--subtle)' }}>Loading channel…</p>}
      {isError && <Notice tone="error">Could not read the contract. Check the network and contract address.</Notice>}
      {channel === null && isChannelId(channelId) && !isLoading && (
        <Notice tone="info">No open channel with this id on this network. It may be closed, reclaimed, or on another network.</Notice>
      )}

      {channel && (
        <>
          <div className="rounded-2xl p-4" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
              Remaining
            </p>
            <p className="display mt-1 text-4xl font-bold tabular-nums">
              {formatUsdc(channel.remaining)} <span className="text-lg font-medium" style={{ color: 'var(--subtle)' }}>USDC</span>
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
            </div>
            <p className="mt-1.5 text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
              {pct.toFixed(1)}% of the deposit claimed
            </p>
          </div>

          <dl className="divide-y" style={{ borderColor: 'var(--border)' }}>
            <Row label="Payer" value={shortHex(channel.payer, 8, 6)} mono />
            <Row label="Payee" value={shortHex(channel.payee, 8, 6)} mono />
            <Row label="Deposit" value={`${formatUsdc(channel.deposit)} USDC`} />
            <Row label="Claimed" value={`${formatUsdc(channel.claimed)} USDC`} />
            <Row label="Remaining" value={`${formatUsdc(channel.remaining)} USDC`} />
            <Row
              label="Expiry"
              value={
                <span style={{ color: expired ? 'var(--danger)' : undefined }}>
                  {new Date(Number(channel.expiresAt) * 1000).toLocaleString()} · {timeLeft(channel.expiresAt, now)}
                </span>
              }
            />
          </dl>

          <ActionButton
            variant="ghost"
            label="Reclaim remaining funds"
            busy={busy}
            busyLabel="Reclaiming…"
            disabled={!isPayer || !expired}
            onClick={onReclaim}
          />
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>{reclaimHint}</p>
        </>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {reclaimed && (
        <div className="space-y-2">
          <Notice tone="success">Reclaimed. The channel is closed.</Notice>
          <ExplorerLink kind="tx" value={reclaimed} label="View reclaim transaction" />
        </div>
      )}
    </Card>
  )
}
