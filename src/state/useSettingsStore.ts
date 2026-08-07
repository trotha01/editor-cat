/** API keys and model preferences. */
import { create } from 'zustand'
import { clearKeys, loadKeys, saveKeys, type KeyState } from '../lib/keys'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_VIDEO_MODEL,
} from '../lib/models'

const PREFS_KEY = 'editor-cat.prefs.v1'

/**
 * Marks preferences that have been through `migratePrefs`. Kept inside the
 * record rather than in the storage key so a migration can rewrite one field
 * without discarding the others.
 */
const PREFS_VERSION = 2

interface Prefs {
  imageModel: string
  videoModel: string
  llmModel: string
  /** Hugging Face repo id for in-browser transcription. */
  speechModel: string
}

const DEFAULT_PREFS: Prefs = {
  imageModel: DEFAULT_IMAGE_MODEL,
  videoModel: DEFAULT_VIDEO_MODEL,
  llmModel: DEFAULT_LLM_MODEL,
  speechModel: DEFAULT_SPEECH_MODEL,
}

const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]

/**
 * The video models this app offered before generation moved onto the site's own
 * fal account.
 *
 * A stored choice among these cannot be told apart from a default that was
 * merely captured in passing — `setPref` writes every field, so changing the
 * image model persists whatever the video default was at the time. Since the
 * site now pays, and these run from two to nine times the cost of the current
 * default, they are moved across. A model ID typed into the custom box is
 * unmistakably deliberate, so it is left alone.
 */
const PRE_SEEDANCE_VIDEO_MODELS = [
  'fal-ai/kling-video/v2/master/image-to-video',
  'fal-ai/minimax/hailuo-02/standard/image-to-video',
  'fal-ai/wan-i2v',
  'fal-ai/luma-dream-machine/image-to-video',
  'fal-ai/veo3/image-to-video',
]

export interface StoredPrefs extends Partial<Prefs> {
  v?: number
}

/**
 * Reads exactly the keys `Prefs` declares, falling back for anything missing or
 * of the wrong type. Adding a preference then means adding it to `DEFAULT_PREFS`
 * and nothing else — the previous hand-written spread silently dropped any
 * field someone forgot to list here.
 */
function snapshotPrefs(source: Partial<Prefs>): Prefs {
  const prefs = { ...DEFAULT_PREFS }
  for (const key of PREF_KEYS) {
    const value = source[key]
    if (typeof value === 'string') prefs[key] = value
  }
  return prefs
}

/** Pure, and exported for tests: stored preferences in, current-shape prefs out. */
export function migratePrefs(stored: StoredPrefs): Prefs {
  const prefs = snapshotPrefs(stored)
  if (stored.v === undefined && PRE_SEEDANCE_VIDEO_MODELS.includes(prefs.videoModel)) {
    prefs.videoModel = DEFAULT_VIDEO_MODEL
  }
  return prefs
}

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFS }

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_PREFS }

    const migrated = migratePrefs(parsed as StoredPrefs)
    // Written back immediately so the migration runs once rather than on every
    // load, and so the version marker exists before anything else is changed.
    persistPrefs(migrated)
    return migrated
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

function persistPrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }))
  } catch {
    // Storage may be unavailable; preferences are not worth failing over.
  }
}

interface SettingsState extends KeyState, Prefs {
  setElevenLabsKey: (value: string) => void
  setRemember: (remember: boolean) => void
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
  forgetKeys: () => void
  hasElevenLabs: () => boolean
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadKeys(),
  ...loadPrefs(),

  setElevenLabsKey: (value) => {
    set((state) => {
      saveKeys({ elevenlabs: value, remember: state.remember })
      return { elevenlabs: value }
    })
  },

  setRemember: (remember) => {
    const { elevenlabs } = get()
    saveKeys({ elevenlabs, remember })
    set({ remember })
  },

  setPref: (key, value) => {
    set((state) => {
      persistPrefs({ ...snapshotPrefs(state), [key]: value })
      return { [key]: value } as Partial<SettingsState>
    })
  },

  forgetKeys: () => {
    clearKeys()
    set({ elevenlabs: '', remember: false })
  },

  hasElevenLabs: () => get().elevenlabs.trim().length > 0,
}))
