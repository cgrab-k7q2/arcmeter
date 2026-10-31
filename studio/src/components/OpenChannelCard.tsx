import { useMemo, useState } from 'react'
import { Landmark } from 'lucide-react'
import { erc20Abi, isAddress, parseEventLogs, type Hash } from 'viem'
import { useReadContract } from 'wagmi'
import { arcMeterAbi, parseTxError } from '@/lib/arcmeter'
import { formatUsdc, parseUsdc } from '@/onchain-money'
import { useMeter } from '@/context/MeterContext'
import { useMeterTx } from '@/hooks/useMeterTx'
import { useRefreshChannels } from '@/hooks/useChannel'
import { useNowSec } from '@/hooks/useNowSec'
import { ActionButton, Card, CopyBox, ExplorerLink, Field, Notice } from './ui'

type Step = 'idle' | 'approving' | 'opening'

export function OpenChannelCard() {
  const { chainId, setChannelId } = useMeter()
  const { account, walletClient, publicClient, meter, waitFor } = useMeterTx()
  const refresh = useRefreshChannels()
  const now = useNowSec()

  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('')
  const [hours, setHours] = useState('24')
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<{ id: string; hash: Hash } | null>(null)

  const { data: token } = useReadContract({
    address: meter,
    abi: arcMeterAbi,
    functionName: 'usdc',
    chainId,
    query: { enabled: !!meter },
  })
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    chainId,
    query: { enabled: !!token && !!account },
  })

  const parsed = useMemo(() => {
    let raw: bigint | null = null
    try {
      raw = amount ? parseUsdc(amount) : null
    } catch {
      raw = null
    }
    const h = Number(hours)
    return { raw: raw && raw > 0n ? raw : null, hours: Number.isFinite(h) && h > 0 && h <= 24 * 365 ? h : null }
  }, [amount, hours])

  const payeeOk = isAddress(payee) && payee.toLowerCase() !== account?.toLowerCase()
  const overBalance = parsed.raw !== null && balance !== undefined && parsed.raw > balance
  const ready = !!meter && !!token && payeeOk && parsed.raw !== null && parsed.hours !== null && !overBalance

  async function onOpen() {
    if (!ready || !publicClient || !walletClient || !account || !meter || !token || parsed.raw === null || parsed.hours === null) return
    setError(null)
    setOpened(null)
    try {
      const allowance = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account, meter],
      })
      if (allowance < parsed.raw) {
        setStep('approving')
        const { request } = await publicClient.simulateContract({
          account,
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [meter, parsed.raw],
        })
        await waitFor(publicClient, await walletClient.writeContract(request))
      }

      setStep('opening')
      const block = await publicClient.getBlock()
      const expiresAt = block.timestamp + BigInt(Math.round(parsed.hours * 3600))
      const { request } = await publicClient.simulateContract({
        account,
        address: meter,
        abi: arcMeterAbi,
        functionName: 'open',
        args: [payee, parsed.raw, expiresAt],
      })
      const hash = await walletClient.writeContract(request)
      const receipt = await waitFor(publicClient, hash)
      const [event] = parseEventLogs({ abi: arcMeterAbi, eventName: 'ChannelOpened', logs: receipt.logs }).filter(
        (log) => log.address.toLowerCase() === meter.toLowerCase(),
      )
      if (!event) throw new Error('ChannelOpened event not found')
      setOpened({ id: event.args.id, hash })
      setChannelId(event.args.id)
      void refresh()
      void refetchBalance()
    } catch (e) {
      setError(parseTxError(e))
    } finally {
      setStep('idle')
    }
  }

  const busy = step !== 'idle'
  const expiryPreview =
    parsed.hours !== null ? new Date((now + parsed.hours * 3600) * 1000).toLocaleString() : null

  return (
    <Card
      step="1 · Payer"
      title="Open channel"
      subtitle="Lock USDC for a payee. You sign vouchers off-chain as usage grows."
      icon={<Landmark className="size-5" />}
    >
      <Field label="Payee address">
        <input
          className="field mono text-sm"
          placeholder="0x…"
          value={payee}
          onChange={(e) => setPayee(e.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      {payee && !payeeOk && (
        <Notice tone="error">{isAddress(payee) ? 'The payee cannot be your own address.' : 'Enter a valid address.'}</Notice>
      )}

      <div className="grid grid-cols-5 gap-3">
        <div className="col-span-3">
          <Field
            label="Deposit (USDC)"
            hint={
              balance !== undefined ? (
                <button type="button" className="font-semibold" style={{ color: 'var(--accent)' }} onClick={() => setAmount(formatUsdc(balance))}>
                  Balance {formatUsdc(balance)} · Max
                </button>
              ) : undefined
            }
          >
            <input
              className="field text-lg tabular-nums"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d{0,6}$/.test(v)) setAmount(v)
              }}
            />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="Hours open">
            <input
              className="field text-lg tabular-nums"
              inputMode="decimal"
              value={hours}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d{0,2}$/.test(v)) setHours(v)
              }}
            />
          </Field>
        </div>
      </div>
      {overBalance && <Notice tone="error">Deposit exceeds your USDC balance.</Notice>}
      {expiryPreview && (
        <p className="text-xs tabular-nums" style={{ color: 'var(--subtle)' }}>
          Expires around {expiryPreview}. After that, vouchers stop working and you can reclaim what is left.
        </p>
      )}

      {!meter && <Notice tone="error">No ArcMeter address is configured for this network. Set one under Contract.</Notice>}

      <ActionButton
        label="Approve + open channel"
        busy={busy}
        busyLabel={step === 'approving' ? 'Approving USDC…' : 'Opening channel…'}
        disabled={!ready}
        onClick={onOpen}
      />
      {error && <Notice tone="error">{error}</Notice>}

      {opened && (
        <div className="space-y-2">
          <Notice tone="success">Channel opened. It is now the active channel in the other cards.</Notice>
          <CopyBox label="Channel id (from ChannelOpened)" value={opened.id} />
          <ExplorerLink kind="tx" value={opened.hash} label="View open transaction" />
        </div>
      )}
    </Card>
  )
}
