/**
 * Bring-your-own-key storage.
 *
 * One key lives here now: ElevenLabs. It belongs to the user and stays on their
 * device — sent per request to our proxy function, which forwards it once to
 * the provider and never writes it anywhere. Nothing here is ever included in
 * exported project data.
 *
 * Persistence is opt-in: with "remember on this device" unticked, the key lives
 * in memory only and is gone on reload.
 *
 * fal used to be stored alongside it. It is now paid for by the deployment and
 * never reaches the browser, so `loadKeys` erases any copy left behind rather
 * than leaving a live credential sitting in local storage forever.
 */

export interface KeyState {
  elevenlabs: string
  remember: boolean
}

const STORAGE_KEY = 'editor-cat.keys.v1'
const REMEMBER_KEY = 'editor-cat.keys.remember.v1'

const EMPTY: KeyState = { elevenlabs: '', remember: false }

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
    const parsed = JSON.parse(raw) as Partial<KeyState> & { fal?: unknown }
    memory = {
      elevenlabs: typeof parsed.elevenlabs === 'string' ? parsed.elevenlabs : '',
      remember: true,
    }
    // This is the only code that ever sees the old shape, so it is the only
    // place that can clean it up.
    if (parsed.fal !== undefined) saveKeys(memory)
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
    store.setItem(STORAGE_KEY, JSON.stringify({ elevenlabs: next.elevenlabs }))
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
