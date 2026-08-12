/**
 * Fixing one clip's audio, started from the clip itself.
 *
 * A store rather than component state for the reason the caption job is one: a
 * run outlives the dialog that started it. Uploading a clip, waiting for it to
 * be segmented, re-saying every line and rendering the result is minutes of
 * round trips to ElevenLabs, and holding a modal open across all of them would
 * lock the editor for something the user has already finished describing. The
 * form closes on the press; this keeps the job, and `AudioFixStatus` reports it
 * beside the timeline.
 *
 * The order below is the whole feature, and each step depends on the one before:
 *
 *  1. **The captions are saved first.** They are the script, so the words that
 *     go to ElevenLabs and the words burnt into the video are the same words by
 *     construction rather than by the user remembering to update both.
 *  2. **Each caption becomes a segment spanning exactly that caption**, so the
 *     line is re-said to fit where the picture says it rather than being said
 *     and then placed. See `clipAudioFix.ts` — that inversion is the whole
 *     reason this goes through dubbing.
 *  3. **The captions are then re-timed to what came back**, word by word, so the
 *     karaoke highlight lands on the syllable actually being spoken.
 *
 * Only one runs at a time. Two would be two dubbing jobs and two bills for a
 * mistimed double-click, and the second would land on captions the first had
 * rewritten.
 */
import { create } from 'zustand'
import { fixClipAudio, type FixTarget } from '../lib/clipAudioFix'
import { VOICE_LANGUAGES } from '../lib/elevenlabs'
import { getBlob } from '../lib/db'
import { ingestBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from './useAssetStore'
import { useProjectStore } from './useProjectStore'
import type { AudioClip } from '../lib/types'

/** Where the language field starts before anybody has chosen one. */
const DEFAULT_LANGUAGE = VOICE_LANGUAGES[0].code

/** What a finished run has to say for itself. */
export interface AudioFixOutcome {
  tone: 'success' | 'warn' | 'error'
  /** Named, because the message outlives the run and the clip menu that started it. */
  label: string
  text: string
  /** The reason behind a warning: what to look at now that it has landed. */
  detail?: string
}

/** One line of the script, as the dialog left it. */
export interface FixRequestLine {
  /** The caption this came from. Absent on a clip that has none. */
  cueId?: string
  text: string
}

/** What the dialog collected before it closed. */
export interface FixRequest {
  /** The lines to say, in order — the clip's captions, as edited. */
  lines: FixRequestLine[]
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
   *
   * The language is never empty, unlike the text-to-speech path this replaced:
   * there a blank meant "read it as it is written", and here a dub has exactly
   * one target language and no such option. A blank would reach the provider as
   * a refusal, so the first of the offered languages stands in until somebody
   * chooses.
   */
  language: string
  voiceId: string

  /** The clip being fixed right now, or null when nothing is running. */
  clipId: string | null
  /** What that clip is called, so the status line can say so while it runs. */
  label: string
  /** What is in flight, in words. */
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
  language: DEFAULT_LANGUAGE,
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
      const lines = request.lines.filter((line) => line.text.trim())
      const asset = useAssetStore.getState().byId(target.assetId)
      if (!asset) throw new Error('This clip’s media is no longer in the library.')
      const media = await getBlob(asset.blobKey)
      if (!media) throw new Error('This clip’s media is no longer stored in this browser.')

      // The captions go down before anything is spent, in one edit. If the run
      // fails at the next step the corrections the user typed are still saved —
      // losing them to a network error would be losing the part they did by
      // hand — and undoing them is one press rather than one press per line.
      useProjectStore
        .getState()
        .setCueTexts(
          lines.flatMap((line) => (line.cueId ? [{ cueId: line.cueId, text: line.text }] : [])),
        )

      const fixed = await fixClipAudio({
        media,
        inPoint: target.inPoint,
        duration: target.duration,
        clipStart: target.startTime,
        // Every line with the marks the picture puts on it, because those marks
        // are what the segments are built from. A clip with no captions comes
        // through as one line spanning the whole clip.
        lines: lines.map((line, index) => ({
          text: line.text,
          start: target.lines[index]?.start ?? target.startTime,
          end: target.lines[index]?.end ?? target.startTime + target.duration,
        })),
        language: request.language,
        voiceId: request.voiceId,
        ...(request.voiceName ? { voiceName: request.voiceName } : {}),
        label: target.label,
        onStage: (stage, done, total) =>
          set({ stage: done > 0 && total > 1 ? `${stage} · ${done} of ${total}` : stage }),
        signal: controller.signal,
      })

      // One asset, not one per line: what comes back is the whole clip re-said
      // as a single track, with every line already sitting where its caption
      // is. There is nothing left to lay out — which is the difference this
      // implementation exists to make, and the reason `layoutSpokenLines` is
      // gone.
      const track = await ingestBlob(fixed.blob, {
        kind: 'audio',
        name: `${target.label} — fixed`,
      })
      useAssetStore.getState().add(track)

      const spokenSeconds = track.duration && track.duration > 0 ? track.duration : target.duration
      const clips: Omit<AudioClip, 'id' | 'trackId' | 'anchorClipId'>[] = [
        {
          assetId: track.id,
          useConverted: false,
          // The clip's own mark. The track is the clip's own length, so this is
          // the only placement there is, and it cannot drift from the picture.
          startTime: target.startTime,
          inPoint: 0,
          duration: spokenSeconds,
          // Labelled, which is also what keeps these out of the Audio step's
          // list of recorded takes: they are not takes, and the only thing
          // offered there — changing the voice — is what has just been done.
          label: `Fixed: ${target.label}`,
          speechFix: {
            text: fixed.lines.map((line) => line.text).join(' '),
            ...(request.language ? { language: request.language } : {}),
            voiceName: fixed.voiceName,
          },
        },
      ]

      // The captions move onto the speech in the same edit as the audio
      // arriving. The words were aligned against this very track, so the
      // highlight follows the new voice exactly — and it has to be the same
      // edit, or an undo would take the audio away and leave the captions timed
      // to something that has gone.
      //
      // Every line is offset by the clip's own start, because that is where the
      // track begins on the timeline and the alignment is measured from the
      // start of the track.
      const retimed = fixed.lines.flatMap((line, index) => {
        const cueId = lines[index]?.cueId
        return cueId && line.words.length > 0
          ? [{ cueId, words: line.words, offset: target.startTime }]
          : []
      })

      const placement = useProjectStore.getState().addFixedClipAudio(target.clipId, clips, retimed)

      const notes = [
        fixed.hurried.count > 0
          ? `${fixed.hurried.count} line${fixed.hurried.count === 1 ? '' : 's'} had more words ` +
            `than would comfortably fit the caption${fixed.hurried.count === 1 ? '' : 's'} ` +
            `${fixed.hurried.count === 1 ? 'it' : 'they'} had to fit, so ` +
            `${fixed.hurried.count === 1 ? 'it was' : 'they were'} read fast rather than allowed ` +
            `to run over. Shorten the text, or give those captions more room.`
          : '',
        retimed.length < fixed.lines.length
          ? `The captions kept their old timings: ElevenLabs returned the audio but not where the ` +
            `words landed in it, so the highlight may sit off the syllable being spoken.`
          : '',
        placement.silenced > 0
          ? `The earlier ${placement.silenced === 1 ? 'take is' : 'takes are'} still on ` +
            `${placement.silenced === 1 ? 'its own lane' : 'their own lanes'}, muted — unmute to ` +
            `compare, or delete what you do not want.`
          : '',
      ].filter(Boolean)

      set({
        outcome: {
          tone: fixed.hurried.count > 0 ? 'warn' : 'success',
          label: target.label,
          text:
            `${target.label} now says your ${lines.length === 1 ? 'line' : `${lines.length} lines`} ` +
            `in ${fixed.voiceName} — ${formatTime(spokenSeconds)} of speech on ` +
            `${placement.trackName}, one track holding every line on its caption's own mark. The ` +
            `captions were re-timed to match, and the clip's own sound is muted; one undo puts all ` +
            `of that back, and a second undo returns the captions to what they said before.`,
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
