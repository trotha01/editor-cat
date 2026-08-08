import { useState } from 'react'

/**
 * `useState`, mirrored into `localStorage` under `key`.
 *
 * Reads happen once, lazily, at mount — a later change made in another tab is
 * not picked up, which is fine for the layout preferences this exists for.
 * Storage being unavailable (private browsing, a full quota) falls back to
 * `initial` rather than throwing: a preference not being remembered is not
 * worth failing the app over.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, (value: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  const update = (next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved))
      } catch {
        // Storage may be unavailable; the preference just won't be remembered.
      }
      return resolved
    })
  }

  return [value, update]
}
