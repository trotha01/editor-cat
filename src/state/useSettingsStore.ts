/** API keys and model preferences. */
import { create } from 'zustand'
import { purgeStoredKeys } from '../lib/keys'
import { siteProvidesKey } from '../lib/elevenlabs'
import { isMockEnabled } from '../lib/mock'
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '../lib/models'

const PREFS_KEY = 'editor-cat.prefs.v1'

/**
 * Marks preferences that have been through `migratePrefs`. Kept inside the
 * record rather than in the storage key so a migration can rewrite one field
 * without discarding the others.
 */
const PREFS_VERSION = 3

interface Prefs {
  imageModel: string
  videoModel: string
}

const DEFAULT_PREFS: Prefs = {
  imageModel: DEFAULT_IMAGE_MODEL,
  videoModel: DEFAULT_VIDEO_MODEL,
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

/**
 * Pure, and exported for tests: stored preferences in, current-shape prefs out.
 *
 * Preferences that no longer exist need no migration — `snapshotPrefs` reads
 * only the keys `Prefs` declares, so a retired one (the in-browser speech model,
 * say) is simply not carried forward.
 */
export function migratePrefs(stored: StoredPrefs): Prefs {
  const prefs = snapshotPrefs(stored)
  const version = stored.v ?? 0
  if (version < 1 && PRE_SEEDANCE_VIDEO_MODELS.includes(prefs.videoModel)) {
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

export interface SettingsState extends Prefs {
  /**
   * Whether this deployment provides an ElevenLabs key of its own, so nobody
   * has to bring one.
   *
   * Starts false and is corrected by `loadElevenLabsSupport` on the first
   * render. False is the safe direction to be wrong in for the moment it lasts:
   * the voice controls are briefly offered as needing a key, rather than
   * briefly promising to work on a deployment where they cannot.
   */
  siteElevenLabs: boolean
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
  /** Asks the proxy whether it has a key. Called once, at startup. */
  loadElevenLabsSupport: () => Promise<void>
}

/**
 * Whether the voice features can run at all.
 *
 * The one question every voice control on screen actually has — the clip menu,
 * the fix dialog, the take cards — so it is answered in one place rather than
 * three subtly different ones. In mock mode the answer is always yes, which is
 * what keeps the whole flow walkable with no provider behind it at all.
 */
export function canUseElevenLabs(state: SettingsState): boolean {
  return state.siteElevenLabs || isMockEnabled()
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...loadPrefs(),
  siteElevenLabs: false,

  setPref: (key, value) => {
    set((state) => {
      persistPrefs({ ...snapshotPrefs(state), [key]: value })
      return { [key]: value } as Partial<SettingsState>
    })
  },

  loadElevenLabsSupport: async () => {
    // The moment to take out the credential nobody can spend any more: this
    // runs once at startup, on every device that ever held one.
    purgeStoredKeys()
    set({ siteElevenLabs: await siteProvidesKey() })
  },
}))
