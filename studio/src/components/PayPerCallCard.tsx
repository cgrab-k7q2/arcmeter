import { useMemo, useState } from 'react'
import { PenLine } from 'lucide-react'
import {
  encodeVoucher,
  parseTxError,
  VOUCHER_HEADER,
  voucherDomain,
  voucherTypes,
} from '@/lib/arcmeter'
import { formatUsdc, parseUsdc } from '@/onchain-money'
import { useMeter } from '@/context/MeterContext'
import { isChannelId, useChannel } from '@/hooks/useChannel'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { useMeterTx } from '@/hooks/useMeterTx'
import { useNowSec } from '@/hooks/useNowSec'
import { ActionButton, Card, CopyBox, Field, Notice } from './ui'

export function PayPerCallCard() {
  const { channelId, chainId } = useMeter()
  const { meter } = useMeterTx()
  return (
    <Card
      step="2 · Payer"
      title="Pay per call"
      subtitle="Sign the next cumulative voucher. Send it with each API request."
      icon={<PenLine className="size-5" />}
    >
      {/* Keyed so the signed-amount counter follows the active channel. */}
      <PayInner key={`${chainId}:${meter}:${channelId}`} />
    </Card>
  )
}

function PayInner() {
  const { channelId, chainId } = useMeter()
  const { account, walletClient, meter } = useMeterTx()
  const { data: channel, isLoading } = useChannel(channelId)
  const now = useNowSec()

  const [price, setPrice] = useState('0.001')
  const [lastSigned, setLastSigned] = useLocalStorage(`arcmeter:signed:${chainId}:${meter ?? ''}:${channelId}`, '0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<{ value: string; cumulative: bigint } | null>(null)

  const priceRaw = useMemo(() => {
    try {
      const raw = price ? parseUsdc(price) : 0n
      return raw > 0n ? raw : null
    } catch {
      return null
    }
  }, [price])

  const base = channel ? (BigInt(lastSigned || '0') > channel.claimed ? BigInt(lastSigned || '0') : channel.claimed) : 0n
  const next = priceRaw !== null ? base + priceRaw : null
  const isPayer = !!channel && !!account && channel.payer.toLowerCase() === account.toLowerCase()
  const expired = channel ? BigInt(now) >= channel.expiresAt : false
  const overDeposit = channel && next !== null ? next > channel.deposit : false

  const blocker = !channelId || !isChannelId(channelId)
    ? 'Open a channel or set one in the status card.'
    : isLoading
      ? null
      : !channel
        ? 'This channel is not open on this network.'
        : !isPayer
          ? 'Connect the payer account to sign vouchers.'
          : expired
            ? 'This channel has expired.'
            : overDeposit
              ? 'The next voucher would exceed the deposit.'
              : null

  async function onSign() {
    if (!channel || !walletClient || !account || !meter || next === null) return
    setBusy(true)
    setError(null)
    try {
      const signature = await walletClient.signTypedData({
        account,
        domain: voucherDomain(chainId, meter),
        types: voucherTypes,
        primaryType: 'Voucher',
        message: { channelId: channel.id, cumulativeAmount: next },
      })
      setToken({ value: encodeVoucher({ c: channel.id, a: next, s: signature }), cumulative: next })
      setLastSigned(next.toString())
    } catch (e) {
      setError(parseTxError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Field label="Price per call (USDC)">
        <input
          className="field text-lg tabular-nums"
          inputMode="decimal"
          placeholder="0.001"
          value={price}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            if (/^\d*\.?\d{0,6}$/.test(v)) setPrice(v)
          }}
        />
      </Field>

      {channel && next !== null && (
        <dl className="rounded-2xl px-4 py-1 text-sm" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)' }}>
          <div className="flex justify-between py-2">
            <dt style={{ color: 'var(--subtle)' }}>Already authorized</dt>
            <dd className="tabular-nums">{formatUsdc(base)} USDC</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt style={{ color: 'var(--subtle)' }}>Next cumulative</dt>
            <dd className="tabular-nums font-semibold">{formatUsdc(next)} USDC</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt style={{ color: 'var(--subtle)' }}>Left after this call</dt>
            <dd className="tabular-nums">{formatUsdc(channel.deposit > next ? channel.deposit - next : 0n)} USDC</dd>
          </div>
        </dl>
      )}

      {blocker && <Notice tone="info">{blocker}</Notice>}

      <ActionButton
        label={next !== null ? `Sign voucher for ${formatUsdc(next)} USDC` : 'Sign next voucher'}
        busy={busy}
        busyLabel="Confirm signature in wallet…"
        disabled={!!blocker || isLoading || priceRaw === null}
        onClick={onSign}
      />
      {error && <Notice tone="error">{error}</Notice>}

      {token && (
        <div className="space-y-3">
          <CopyBox label={`${VOUCHER_HEADER} (cumulative ${formatUsdc(token.cumulative)} USDC)`} value={token.value} />
          <CopyBox label="Full header" value={`${VOUCHER_HEADER}: ${token.value}`} />
          <p className="text-xs text-pretty" style={{ color: 'var(--subtle)' }}>
            Base64url of {'{c: channelId, a: cumulative, s: signature}'}. Signing costs no gas. Each new voucher replaces the previous one.
          </p>
        </div>
      )}
    </>
  )
}
