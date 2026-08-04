/**
 * Bring-your-own-key storage.
 *
 * Keys belong to the user and stay on their device. They are sent per request
 * to our proxy functions, which forward them once to the provider and never
 * write them anywhere. Nothing here is ever included in exported project data.
 *
 * Persistence is opt-in: with "remember on this device" unticked, keys live in
 * memory only and are gone on reload.
 */

export type ProviderId = 'fal' | 'elevenlabs'

export interface KeyState {
  fal: string
  elevenlabs: string
  remember: boolean
}

const STORAGE_KEY = 'editor-cat.keys.v1'
const REMEMBER_KEY = 'editor-cat.keys.remember.v1'

const EMPTY: KeyState = { fal: '', elevenlabs: '', remember: false }

/** In-memory keys, used when the user has not opted into persistence. */
let memory: KeyState = { ...EMPTY }

function safeLocalStorage(): Storage | null {
  try {
    // Access can throw in private-browsing modes and sandboxed frames.
    return window.localStorage
  } catch {
    return null
  }
}

export function loadKeys(): KeyState {
  const store = safeLocalStorage()
  if (!store) return { ...memory }

  const remember = store.getItem(REMEMBER_KEY) === '1'
  if (!remember) return { ...memory, remember: false }

  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return { ...memory, remember: true }
    const parsed = JSON.parse(raw) as Partial<KeyState>
    memory = {
      fal: typeof parsed.fal === 'string' ? parsed.fal : '',
      elevenlabs: typeof parsed.elevenlabs === 'string' ? parsed.elevenlabs : '',
      remember: true,
    }
    return { ...memory }
  } catch {
    return { ...memory, remember: true }
  }
}

export function saveKeys(next: KeyState): void {
  memory = { ...next }
  const store = safeLocalStorage()
  if (!store) return

  if (next.remember) {
    store.setItem(REMEMBER_KEY, '1')
    store.setItem(STORAGE_KEY, JSON.stringify({ fal: next.fal, elevenlabs: next.elevenlabs }))
  } else {
    // Turning "remember" off must actively erase what was already written.
    store.removeItem(REMEMBER_KEY)
    store.removeItem(STORAGE_KEY)
  }
}

export function clearKeys(): void {
  memory = { ...EMPTY }
  const store = safeLocalStorage()
  store?.removeItem(STORAGE_KEY)
  store?.removeItem(REMEMBER_KEY)
}

/** Shows enough of a key to recognise it without revealing it. */
export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 8) return '•'.repeat(trimmed.length)
  return `${trimmed.slice(0, 4)}${'•'.repeat(Math.min(16, trimmed.length - 8))}${trimmed.slice(-4)}`
}
