import { useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { useMeter } from '@/context/MeterContext'
import { explorerBase } from '@/lib/chains'

export function Card({
  step,
  title,
  subtitle,
  icon,
  children,
}: {
  step: string
  title: string
  subtitle: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5 flex items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'var(--surface-strong)', color: 'var(--accent)' }}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--subtle)' }}>
            {step}
          </p>
          <h2 className="display text-xl font-semibold text-balance">{title}</h2>
          <p className="mt-0.5 text-sm text-pretty" style={{ color: 'var(--muted)' }}>
            {subtitle}
          </p>
        </div>
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-xs font-semibold" style={{ color: 'var(--muted)' }}>
        <span>{label}</span>
        {hint && (
          <span className="font-normal tabular-nums" style={{ color: 'var(--subtle)' }}>
            {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  )
}

export function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm">
      <dt style={{ color: 'var(--subtle)' }}>{label}</dt>
      <dd className={`min-w-0 truncate text-right tabular-nums ${mono ? 'mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}

export function Notice({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  const color = tone === 'error' ? 'var(--danger)' : tone === 'success' ? 'var(--success)' : 'var(--muted)'
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="rounded-xl px-3.5 py-2.5 text-sm text-pretty"
      style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${color}`, color }}
    >
      {children}
    </div>
  )
}

export function ExplorerLink({ kind, value, label }: { kind: 'tx' | 'address'; value: string; label?: string }) {
  const { chain } = useMeter()
  const base = explorerBase(chain)
  if (!base) return null
  return (
    <a
      href={`${base}/${kind}/${value}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs font-semibold"
      style={{ color: 'var(--accent)' }}
    >
      {label ?? 'View on explorer'} <ExternalLink className="size-3" />
    </a>
  )
}

export function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border)' }}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          {label}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold"
          style={{ color: 'var(--accent)' }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mono break-all text-xs leading-relaxed" style={{ color: 'var(--ink-2)' }}>
        {value}
      </p>
    </div>
  )
}

/**
 * Primary action that handles the wallet gates itself: connect, then switch to the app's
 * selected chain, and only then runs `onClick`.
 */
export function ActionButton({
  label,
  busyLabel,
  busy,
  disabled,
  onClick,
  variant = 'primary',
}: {
  label: string
  busyLabel?: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void | Promise<void>
  variant?: 'primary' | 'ghost'
}) {
  const { isConnected, chainId: walletChainId } = useAccount()
  const { chain, chainId } = useMeter()
  const { switchChain, isPending: switching } = useSwitchChain()
  const cls = variant === 'primary' ? 'btn-primary' : 'btn-ghost'

  if (!isConnected) {
    return (
      <ConnectKitButton.Custom>
        {({ show }) => (
          <button type="button" className={cls} onClick={show}>
            Connect wallet
          </button>
        )}
      </ConnectKitButton.Custom>
    )
  }
  if (walletChainId !== chainId) {
    return (
      <button
        type="button"
        className={cls}
        disabled={switching}
        onClick={() => switchChain({ chainId })}
      >
        {switching ? 'Switching…' : `Switch to ${chain.name}`}
      </button>
    )
  }
  return (
    <button type="button" className={cls} disabled={disabled || busy} onClick={() => void onClick()}>
      {busy ? (
        <span className="flex items-center justify-center gap-2">
          <Loader2 className="size-4 animate-spin" /> {busyLabel ?? 'Working…'}
        </span>
      ) : (
        label
      )}
    </button>
  )
}
