import { useCallback, useState } from 'react'

/** String state mirrored to localStorage. Never use for secrets. */
export function useLocalStorage(key: string, initial = ''): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? initial
    } catch {
      return initial
    }
  })
  const update = useCallback(
    (next: string) => {
      setValue(next)
      try {
        if (next) window.localStorage.setItem(key, next)
        else window.localStorage.removeItem(key)
      } catch {
        // storage unavailable: keep in-memory state only
      }
    },
    [key],
  )
  return [value, update]
}
