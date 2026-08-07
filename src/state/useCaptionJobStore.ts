/**
 * Captioning one clip, started from the clip itself.
 *
 * The Captions step transcribes the whole timeline. This is the other way in —
 * the menu on a clip, which is where you are looking at the moment you notice
 * that one take came out wrong, rather than four panels away.
 *
 * It lives in a store rather than in the timeline components because a run
 * outlives the menu that started it: the menu closes on the click and the words
 * arrive seconds later, so something that is not the menu has to be holding the
 * job. Only one runs at a time, for the same reason the panel only runs one —
 * two transcripts landing on the same track would each be replacing what the
 * other had just written.
 */
import { create } from 'zustand'
import { transcribeTimeline, type TranscribeProgress } from '../lib/transcribeTimeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from './useAssetStore'
import { useProjectStore } from './useProjectStore'
import type { SpeechSource } from '../lib/captionSources'

/** What a finished run has to say for itself. */
export interface CaptionJobOutcome {
  tone: 'success' | 'warn' | 'error'
  /** Named, because the message outlives the run and the clip menu that started it. */
  label: string
  text: string
  /** The reason behind a warning: what failed, or what would not fit. */
  detail?: string
}

interface CaptionJobState {
  /**
   * Which language to transcribe as, or empty to let Scribe detect it.
   *
   * Shared with the Captions step rather than asked for twice: what is spoken is
   * a property of the project's audio, not of the button that happens to be
   * pressed, and a clip redone from the timeline must not quietly come back in
   * another language than the rest.
   */
  language: string
  setLanguage: (code: string) => void

  /** The clip being transcribed right now, or null when nothing is running. */
  clipId: string | null
  /** What that clip is called, so the status line can say so while it runs. */
  label: string
  progress: TranscribeProgress | null
  outcome: CaptionJobOutcome | null

  captionClip: (source: SpeechSource) => Promise<void>
  cancel: () => void
  dismiss: () => void
}

/**
 * The in-flight run's canceller. Outside the store because nothing renders from
 * it — putting it in state would only be a way to notify subscribers of a
 * change they cannot see.
 */
let inFlight: AbortController | null = null

export const useCaptionJobStore = create<CaptionJobState>((set, get) => ({
  language: '',
  setLanguage: (language) => set({ language }),

  clipId: null,
  label: '',
  progress: null,
  outcome: null,

  captionClip: async (source) => {
    // A second press while one is running is a double-click, not a request for
    // two runs. Checked before the first await, which is the only place it can
    // be checked at all.
    if (get().clipId !== null) return

    const controller = new AbortController()
    inFlight = controller
    set({ clipId: source.id, label: source.label, progress: null, outcome: null })

    try {
      const { language } = get()
      const trackId = useProjectStore.getState().ensureCaptionTrack()
      const transcript = await transcribeTimeline({
        sources: [source],
        assets: useAssetStore.getState().assets,
        ...(language ? { languageCode: language } : {}),
        onProgress: (progress) => set({ progress }),
        signal: controller.signal,
      })

      // A clip that could not be transcribed keeps the captions it has. The
      // failure is a network fault or a file this browser cannot decode — a
      // reason to press again, never a reason to lose words that were already
      // right.
      if (transcript.failures.length > 0) {
        set({
          outcome: {
            tone: 'warn',
            label: source.label,
            text: `${source.label} could not be transcribed, and was left exactly as it was.`,
            detail: transcript.failures.join(' · '),
          },
        })
        return
      }

      const { added, replaced, dropped } = useProjectStore
        .getState()
        .setCaptionsFromSource(trackId, source.id, transcript.words)

      const parts = [
        added === 0
          ? `No speech was recognised in ${source.label}`
          : `${added} caption${added === 1 ? '' : 's'} from ${transcript.words.length} words in ${source.label}`,
      ]
      if (replaced > 0)
        parts.push(`replaced ${replaced} caption${replaced === 1 ? '' : 's'} from it`)
      if (transcript.languages.length > 0) parts.push(`heard as ${transcript.languages.join(', ')}`)

      set({
        outcome: {
          // Nothing recognised, or captions that would not fit, are both
          // outcomes worth a second look rather than a tick.
          tone: added === 0 || dropped > 0 ? 'warn' : 'success',
          label: source.label,
          text: parts.join(' · '),
          ...(dropped > 0
            ? {
                detail:
                  `${dropped} caption${dropped === 1 ? '' : 's'} would have covered captions ` +
                  `from another clip, so ${dropped === 1 ? 'it was' : 'they were'} left out. ` +
                  `Move or delete those captions and try again.`,
              }
            : {}),
        },
      })
    } catch (cause) {
      // A cancelled run says nothing: the user already knows, having asked.
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      set({
        outcome: { tone: 'error', label: source.label, text: toDisplayMessage(cause) },
      })
    } finally {
      inFlight = null
      set({ clipId: null, progress: null })
    }
  },

  cancel: () => inFlight?.abort(),

  dismiss: () => set({ outcome: null }),
}))
