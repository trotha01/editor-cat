/**
 * Fixing one clip's audio, started from the clip itself.
 *
 * A store rather than component state for the reason the caption job is one: a
 * run outlives the dialog that started it. Copying a voice and then speaking a
 * line at a time is several round trips to ElevenLabs, and holding a modal open
 * across all of them would lock the editor for something the user has already
 * finished describing. The form closes on the press; this keeps the job, and
 * `AudioFixStatus` reports it beside the timeline.
 *
 * The order below is the whole feature, and each step depends on the one before:
 *
 *  1. **The captions are saved first.** They are the script, so the words that
 *     go to ElevenLabs and the words burnt into the video are the same words by
 *     construction rather than by the user remembering to update both.
 *  2. **Each line is spoken on its own**, so it can be laid where its caption
 *     starts — which is where the picture says it, give or take the room a
 *     quicker reading leaves for the line after it.
 *  3. **The captions are then re-timed to what came back**, word by word, so the
 *     karaoke highlight lands on the syllable actually being spoken.
 *
 * Only one runs at a time. Two would be two clones and two bills for a mistimed
 * double-click, and the second would land on captions the first had rewritten.
 */
import { create } from 'zustand'
import { fixClipAudio, layoutSpokenLines, type FixTarget } from '../lib/clipAudioFix'
import { getBlob } from '../lib/db'
import { ingestBlob } from '../lib/media'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from './useAssetStore'
import { useProjectStore } from './useProjectStore'
import type { AudioClip } from '../lib/types'

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

      const { spoken, voiceName } = await fixClipAudio({
        media,
        inPoint: target.inPoint,
        duration: target.duration,
        lines: lines.map((line) => line.text),
        language: request.language,
        voiceId: request.voiceId,
        voiceName: request.voiceName,
        label: target.label,
        onStage: (stage, done, total) =>
          set({ stage: total > 1 ? `${stage} · ${done + 1} of ${total}` : stage }),
        signal: controller.signal,
      })

      // Ingested before they are laid out, because only a decoded file knows how
      // long it really runs — and how long each line runs is what decides
      // whether the one after it still fits where its caption starts.
      const pieces = []
      for (const [index, line] of spoken.entries()) {
        const fixed = await ingestBlob(line.blob, {
          kind: 'audio',
          name: `${target.label} — fixed line ${index + 1}`,
        })
        useAssetStore.getState().add(fixed)
        pieces.push({
          asset: fixed,
          words: line.words,
          text: line.text,
          cueId: lines[index]?.cueId,
          // The caption's own mark, or the head of the clip for a clip with no
          // captions to take a mark from.
          wanted: target.lines[index]?.start ?? target.startTime,
          // Where the caption ended before any of this — how long the
          // performance took over these words, which is what says whether the
          // new reading leaves room behind it for the next line to move into.
          wantedEnd: target.lines[index]?.end ?? target.startTime + target.duration,
          duration:
            fixed.duration && fixed.duration > 0
              ? fixed.duration
              : (line.words.at(-1)?.end ?? target.duration),
        })
      }

      const placed = layoutSpokenLines(
        pieces.map((piece) => ({
          start: piece.wanted,
          end: piece.wantedEnd,
          duration: piece.duration,
        })),
      )
      const clips: Omit<AudioClip, 'id' | 'trackId' | 'anchorClipId'>[] = pieces.map(
        (piece, index) => ({
          assetId: piece.asset.id,
          useConverted: false,
          startTime: placed[index]?.start ?? piece.wanted,
          inPoint: 0,
          duration: piece.duration,
          // Labelled, which is also what keeps these out of the Audio step's
          // list of recorded takes: they are not takes, and the only thing
          // offered there — changing the voice — is what has just been done.
          label:
            pieces.length > 1
              ? `Fixed ${index + 1}/${pieces.length}: ${target.label}`
              : `Fixed: ${target.label}`,
          speechFix: {
            text: piece.text,
            ...(request.language ? { language: request.language } : {}),
            voiceName,
          },
        }),
      )

      // The captions move onto the speech in the same edit as the audio
      // arriving. That is what "the timing lines up" actually means — the words
      // were spoken from these very captions, so the highlight follows the new
      // voice exactly — and it has to be the same edit, or an undo would take
      // the audio away and leave the captions timed to something that has gone.
      const retimed = pieces.flatMap((piece, index) =>
        piece.cueId && piece.words.length > 0
          ? [
              {
                cueId: piece.cueId,
                words: piece.words,
                offset: placed[index]?.start ?? piece.wanted,
              },
            ]
          : [],
      )

      const placement = useProjectStore.getState().addFixedClipAudio(target.clipId, clips, retimed)

      const spokenSeconds = pieces.reduce((total, piece) => total + piece.duration, 0)
      const pushed = placed.filter((entry) => entry.pushed).length
      const pulled = placed.filter((entry) => entry.pulled).length
      const notes = [
        pushed > 0
          ? `${pushed} line${pushed === 1 ? '' : 's'} had to start late, because the line before ` +
            `${pushed === 1 ? 'it was' : 'them were'} still being said. Shorten the text, or give ` +
            `those captions more room, to bring ${pushed === 1 ? 'it' : 'them'} back onto the mark.`
          : '',
        pulled > 0
          ? `${pulled} line${pulled === 1 ? '' : 's'} came in early, into room the reading before ` +
            `${pulled === 1 ? 'it' : 'them'} finished ahead of. Left as silence that would sound ` +
            `like the audio cutting out mid-sentence rather than like a pause.`
          : '',
        placement.silenced > 0
          ? `The earlier ${placement.silenced === 1 ? 'take is' : 'takes are'} still on ` +
            `${placement.silenced === 1 ? 'its own lane' : 'their own lanes'}, muted — unmute to ` +
            `compare, or delete what you do not want.`
          : '',
      ].filter(Boolean)

      set({
        outcome: {
          tone: pushed > 0 ? 'warn' : 'success',
          label: target.label,
          text:
            `${target.label} now says your ${pieces.length === 1 ? 'line' : `${pieces.length} lines`} ` +
            `in ${voiceName} — ${formatTime(spokenSeconds)} of speech on ${placement.trackName}, ` +
            `on the captions’ own marks. The captions were re-timed to match, and the ` +
            `clip’s own sound is muted; one undo puts all of that back, and a second undo returns ` +
            `the captions to what they said before.`,
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
