import { ConnectKitButton } from 'connectkit'
import { Gauge, Settings2 } from 'lucide-react'
import { isAddress } from 'viem'
import { APP_CHAINS } from '@/lib/chains'
import { useMeter } from '@/context/MeterContext'
import { ExplorerLink, Field } from './ui'

export function AppHeader() {
  const { chain, setChainId, address, addressOverride, setAddressOverride } = useMeter()
  const invalid = addressOverride.trim() !== '' && !isAddress(addressOverride.trim())

  return (
    <header className="mb-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-10 items-center justify-center rounded-xl" style={{ background: 'var(--accent)', color: '#0d1b2f' }}>
            <Gauge className="size-5" />
          </div>
          <div>
            <h1 className="display text-2xl font-bold leading-none">ArcMeter</h1>
            <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
              USDC payment channels for pay-per-call APIs
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {APP_CHAINS.length > 1 ? (
            <select
              aria-label="Network"
              className="field !w-auto text-sm"
              value={chain.id}
              onChange={(e) => setChainId(Number(e.target.value))}
            >
              {APP_CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span
              className="inline-flex min-h-11 items-center rounded-2xl px-3.5 text-sm font-semibold"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              {chain.name}
            </span>
          )}
          <ConnectKitButton />
        </div>
      </div>

      <details className="card group px-5 py-3">
        <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm font-semibold">
          <Settings2 className="size-4" style={{ color: 'var(--accent)' }} />
          Contract
          <span className="mono ml-auto truncate text-xs font-normal" style={{ color: 'var(--subtle)' }}>
            {address ?? 'not configured'}
          </span>
        </summary>
        <div className="mt-3 space-y-3 pb-2">
          <Field label={`ArcMeter address on ${chain.name}`} hint="overrides VITE_ARCMETER_ADDRESS_<chainId>">
            <input
              className="field mono text-xs"
              placeholder={address ?? '0x…'}
              value={addressOverride}
              onChange={(e) => setAddressOverride(e.target.value.trim())}
              spellCheck={false}
            />
          </Field>
          {invalid && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              Not a valid address. Using the configured default.
            </p>
          )}
          {address && <ExplorerLink kind="address" value={address} label="View contract" />}
        </div>
      </details>
    </header>
  )
}
