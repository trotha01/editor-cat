/** API keys and model preferences. */
import { create } from 'zustand'
import { clearKeys, loadKeys, saveKeys, type KeyState } from '../lib/keys'
import { DEFAULT_IMAGE_MODEL, DEFAULT_LLM_MODEL, DEFAULT_VIDEO_MODEL } from '../lib/models'

const PREFS_KEY = 'editor-cat.prefs.v1'

interface Prefs {
  imageModel: string
  videoModel: string
  llmModel: string
}

const DEFAULT_PREFS: Prefs = {
  imageModel: DEFAULT_IMAGE_MODEL,
  videoModel: DEFAULT_VIDEO_MODEL,
  llmModel: DEFAULT_LLM_MODEL,
}

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

function persistPrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage may be unavailable; preferences are not worth failing over.
  }
}

interface SettingsState extends KeyState, Prefs {
  setKey: (provider: 'fal' | 'elevenlabs', value: string) => void
  setRemember: (remember: boolean) => void
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
  forgetKeys: () => void
  hasFal: () => boolean
  hasElevenLabs: () => boolean
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...loadKeys(),
  ...loadPrefs(),

  setKey: (provider, value) => {
    set((state) => {
      const next = { ...state, [provider]: value } as SettingsState
      saveKeys({ fal: next.fal, elevenlabs: next.elevenlabs, remember: next.remember })
      return { [provider]: value } as Partial<SettingsState>
    })
  },

  setRemember: (remember) => {
    const { fal, elevenlabs } = get()
    saveKeys({ fal, elevenlabs, remember })
    set({ remember })
  },

  setPref: (key, value) => {
    set((state) => {
      const next = {
        imageModel: state.imageModel,
        videoModel: state.videoModel,
        llmModel: state.llmModel,
        [key]: value,
      }
      persistPrefs(next as Prefs)
      return { [key]: value } as Partial<SettingsState>
    })
  },

  forgetKeys: () => {
    clearKeys()
    set({ fal: '', elevenlabs: '', remember: false })
  },

  hasFal: () => get().fal.trim().length > 0,
  hasElevenLabs: () => get().elevenlabs.trim().length > 0,
}))
