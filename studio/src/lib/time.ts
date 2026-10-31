/** "2h 5m", "45s", or "expired" for a unix-seconds expiry relative to `nowSec`. */
export function timeLeft(expiresAt: bigint, nowSec: number): string {
  const diff = Number(expiresAt) - nowSec
  if (diff <= 0) return 'expired'
  const d = Math.floor(diff / 86400)
  const h = Math.floor((diff % 86400) / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
