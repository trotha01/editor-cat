/**
 * Fixing one clip's audio, started from the clip itself.
 *
 * A store rather than component state for the reason the caption job is one: a
 * run outlives the dialog that started it. Copying a voice and then speaking a
 * line is two round trips to ElevenLabs, and holding a modal open across both of
 * them would lock the editor for something the user has already finished
 * describing. The form closes on the press; this keeps the job, and
 * `AudioFixStatus` reports it beside the timeline.
 *
 * Only one runs at a time. Two would be two clones and two bills for a mistimed
 * double-click, and the second would land on a project the first had already
 * changed.
 */
import { create } from 'zustand'
import { fixClipAudio, type FixTarget } from '../lib/clipAudioFix'
import { getBlob } from '../lib/db'
import { ingestBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from './useAssetStore'
import { useProjectStore } from './useProjectStore'

/** What a finished run has to say for itself. */
export interface AudioFixOutcome {
  tone: 'success' | 'warn' | 'error'
  /** Named, because the message outlives the run and the clip menu that started it. */
  label: string
  text: string
  /** The reason behind a warning: what to look at now that it has landed. */
  detail?: string
}

/** What the dialog collected before it closed. */
export interface FixRequest {
  /** What the clip should be saying. */
  text: string
  /** ISO-639-1, or empty to let the model read the language off the text. */
  language: string
  /** An ElevenLabs voice id, or empty to copy the clip's own voice. */
  voiceId: string
  /** What that voice is called. The dialog has the list; nothing here does. */
  voiceName?: string
}

interface AudioFixState {
  /**
   * What the dialog opens with next time, kept here rather than in the form.
   *
   * A project is usually one language pair throughout — that is what makes it a
   * project rather than a pile of clips — so the second clip you fix should not
   * ask again from scratch. Both are still per-clip choices; this only decides
   * where the fields start.
   */
  language: string
  voiceId: string

  /** The clip being fixed right now, or null when nothing is running. */
  clipId: string | null
  /** What that clip is called, so the status line can say so while it runs. */
  label: string
  /** Which of the two round trips is in flight, in words. */
  stage: string | null
  outcome: AudioFixOutcome | null

  fixClip: (target: FixTarget, request: FixRequest) => Promise<void>
  cancel: () => void
  dismiss: () => void
}

/**
 * The in-flight run's canceller. Outside the store because nothing renders from
 * it — putting it in state would only be a way to notify subscribers of a
 * change they cannot see.
 */
let inFlight: AbortController | null = null

export const useAudioFixStore = create<AudioFixState>((set, get) => ({
  language: '',
  voiceId: '',

  clipId: null,
  label: '',
  stage: null,
  outcome: null,

  fixClip: async (target, request) => {
    // A second press while one is running is a double-click, not a request for
    // two runs. Checked before the first await, which is the only place it can
    // be checked at all.
    if (get().clipId !== null) return

    const controller = new AbortController()
    inFlight = controller
    set({
      clipId: target.clipId,
      label: target.label,
      stage: null,
      outcome: null,
      language: request.language,
      voiceId: request.voiceId,
    })

    try {
      const asset = useAssetStore.getState().byId(target.assetId)
      if (!asset) throw new Error('This clip’s media is no longer in the library.')
      const media = await getBlob(asset.blobKey)
      if (!media) throw new Error('This clip’s media is no longer stored in this browser.')

      const { blob, voiceName } = await fixClipAudio({
        media,
        inPoint: target.inPoint,
        duration: target.duration,
        text: request.text,
        language: request.language,
        voiceId: request.voiceId,
        voiceName: request.voiceName,
        label: target.label,
        onStage: (stage) => set({ stage }),
        signal: controller.signal,
      })

      const fixed = await ingestBlob(blob, {
        kind: 'audio',
        name: `${target.label} — fixed audio`,
      })
      useAssetStore.getState().add(fixed)

      const spoken = fixed.duration && fixed.duration > 0 ? fixed.duration : target.duration
      const placement = useProjectStore.getState().addFixedClipAudio(target.clipId, {
        assetId: fixed.id,
        useConverted: false,
        startTime: target.startTime,
        inPoint: 0,
        duration: spoken,
        // Labelled, which is also what keeps it out of the Audio step's list of
        // recorded takes: this is not one, and the only thing offered there —
        // changing the voice — is what has just been done to it.
        label: `Fixed: ${target.label}`,
        speechFix: {
          text: request.text.trim(),
          ...(request.language ? { language: request.language } : {}),
          voiceName,
        },
      })

      // Nothing stretches speech to fit a shot, so the one thing worth saying
      // about a fix that worked is how it sits against the picture. The second
      // is where the go before it went, since it is still there.
      const overrun = spoken - target.duration
      const notes = [
        overrun > 0.25
          ? `The line runs ${formatTime(overrun)} past the end of the clip. Trim it on its ` +
            `lane, hold the clip longer, or shorten the text and fix it again.`
          : '',
        placement.silenced > 0
          ? `The earlier ${placement.silenced === 1 ? 'take is' : 'takes are'} still on ` +
            `${placement.silenced === 1 ? 'its own lane' : 'their own lanes'}, muted — unmute to ` +
            `compare, or delete what you do not want.`
          : '',
      ].filter(Boolean)

      set({
        outcome: {
          tone: overrun > 0.25 ? 'warn' : 'success',
          label: target.label,
          text:
            `${target.label} now says your line in ${voiceName} — ${formatTime(spoken)} of ` +
            `speech under a ${formatTime(target.duration)} clip, on ${placement.trackName}. ` +
            `The clip’s own sound is muted; undo puts it back.`,
          ...(notes.length > 0 ? { detail: notes.join(' ') } : {}),
        },
      })
    } catch (cause) {
      // A cancelled run says nothing: the user already knows, having asked.
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      set({ outcome: { tone: 'error', label: target.label, text: toDisplayMessage(cause) } })
    } finally {
      inFlight = null
      set({ clipId: null, stage: null })
    }
  },

  cancel: () => inFlight?.abort(),

  dismiss: () => set({ outcome: null }),
}))
