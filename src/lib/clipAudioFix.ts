/**
 * Fixing a clip that says the words with the wrong sounds.
 *
 * A video model asked for a line in two languages will happily deliver one: the
 * English half lands, and the Spanish or Italian half comes out with an English
 * mouth — stress on the wrong syllable, vowels from the wrong alphabet, a word
 * or two invented outright. Nothing can be done to that performance afterwards.
 * A voice changer keeps the delivery it is given, which is precisely the part
 * that is wrong, and re-generating the clip is a new roll of the dice on
 * everything else in the shot.
 *
 * So the line is said again from the text, and **the captions are that text**.
 * Not a copy of them to correct separately — the captions themselves, edited in
 * the dialog and saved before a word is spoken, so what is burnt into the video
 * and what is heard in it cannot disagree.
 *
 * Using them buys the timing as well as the words. A caption knows when its line
 * starts and how long the performance took over it, because it was transcribed
 * from that performance; so each line is spoken as its own request and laid at
 * its own mark — give or take the room a quicker reading leaves for the next one
 * to move into — and the new speech tracks the mouth it is standing in for
 * instead of drifting away over the clip. What comes back carries per-word
 * timings, and those go
 * the other way — onto the captions, so the highlight lands on the syllable
 * being spoken rather than on the one the old audio used to say there.
 *
 * The clip's own sound is muted and the picture is untouched. Nothing here is
 * lip-sync, and nothing pretends to be; it is the same rhythm, said properly.
 *
 * The provider calls live in `elevenlabs.ts`. What is here is the choosing —
 * which clips can be fixed, what the dialog opens with, where each line lands —
 * plus the cleanup, because copying a voice leaves one behind in the account
 * until it is deleted.
 */
import { cloneVoice, deleteVoice, speak, type SpokenWord } from './elevenlabs'
import { captionCuesOf, cueText } from './captions'
import { decodeAudio, monoWav } from './speechAudio'
import { layoutClips, leadInOf } from './timeline'
import type { Asset, AudioClip, Project } from './types'

/**
 * How much of a clip is handed over to copy the voice from.
 *
 * ElevenLabs asks for a minute or more to clone well and takes far less; a clip
 * is what there is, and most of them are seconds long. The cap is here for the
 * long ones — the sample travels as uncompressed PCM through a serverless proxy
 * with a payload ceiling, and thirty seconds is both comfortably inside it and
 * more of one voice than any clone gets better for.
 */
export const CLONE_SAMPLE_SECONDS = 30

/**
 * Ceiling on the sample's rate. Under it, the clip's own rate is kept.
 *
 * Cloning listens to timbre, which lives in exactly the high frequencies that
 * transcription throws away — so this is not the 16kHz the rest of the app
 * sends. Upsampling a source that was never that detailed would only make the
 * request bigger, so the source rate wins whenever it is lower.
 */
const CLONE_SAMPLE_RATE = 44100

/**
 * One caption under the clip: what it says, and when the picture says it.
 *
 * The unit everything works in. Each of these becomes one request, one piece of
 * audio laid at `start`, and one caption re-timed to what came back.
 */
export interface FixLine {
  cueId: string
  /** Where the caption starts on the timeline, which is where its line is laid. */
  start: number
  /** Where it currently ends. Replaced by however long the new line takes. */
  end: number
  text: string
}

/** A clip whose sound can be replaced, and what a fix for it would start from. */
export interface FixTarget {
  /** The picture clip whose own sound is wrong. */
  clipId: string
  /** What its media is called, for the menu, the dialog and the status line. */
  label: string
  assetId: string
  /** Where the clip starts on the timeline, which is where the fix is laid. */
  startTime: number
  /** Seconds into the source file. */
  inPoint: number
  /** How much of the source the clip uses. */
  duration: number
  /**
   * This clip's captions, in the order they are spoken. Empty when it has none.
   *
   * The script. They are already the words of this clip, transcribed from this
   * clip, so the usual job is correcting a spelling rather than typing a line —
   * and the thing wrong with them is usually the thing wrong with the audio.
   */
  lines: FixLine[]
  /**
   * The same words as one string, for a clip with no captions to work from.
   *
   * A fallback in every sense: one request, laid at the head of the clip, with
   * no line-by-line timing to hold it to the picture. Captioning the clip first
   * is the better road and the dialog says so.
   */
  text: string
  /** The language a previous fix enforced, so a redo defaults to the same one. */
  language?: string
  /**
   * The newest correction already sitting under this clip, if any.
   *
   * What makes the menu say "redo" rather than "fix", and where the text box
   * starts from. Nothing replaces it — another go lands on a lane of its own —
   * so this is the latest of however many there are.
   */
  fixedAudioClipId?: string
}

/**
 * Every clip that could have its sound replaced, keyed by clip id.
 *
 * Stills are left out: there is no voice in a photograph and nothing to mute.
 * A clip that has *already* been silenced is deliberately kept in, unlike the
 * captioning targets next door — muting is what a fix does, so a fixed clip
 * would otherwise lose the menu item that redoes it the moment it worked.
 */
export function fixTargets(project: Project, assets: readonly Asset[]): Map<string, FixTarget> {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]))

  // Last one wins: fixes are appended, so the newest is the one whose words a
  // redo should open with.
  const fixes = new Map<string, AudioClip>()
  for (const clip of project.audioClips ?? []) {
    if (clip.speechFix && clip.anchorClipId) fixes.set(clip.anchorClipId, clip)
  }

  const heard = new Map<string, FixLine[]>()
  for (const cue of [...captionCuesOf(project)].sort((a, b) => a.start - b.start)) {
    if (!cue.source) continue
    const lines = heard.get(cue.source.id) ?? []
    lines.push({ cueId: cue.id, start: cue.start, end: cue.end, text: cueText(cue) })
    heard.set(cue.source.id, lines)
  }

  const targets = new Map<string, FixTarget>()
  for (const positioned of layoutClips(project.clips, leadInOf(project))) {
    const asset = assetById.get(positioned.clip.assetId)
    if (asset?.kind !== 'video' || !(positioned.duration > 0)) continue

    const fixed = fixes.get(positioned.clip.id)
    const lines = heard.get(positioned.clip.id) ?? []
    targets.set(positioned.clip.id, {
      clipId: positioned.clip.id,
      label: asset.name,
      assetId: asset.id,
      startTime: positioned.start,
      inPoint: positioned.clip.inPoint,
      duration: positioned.duration,
      lines,
      // The captions win over the last correction here, unlike before: they are
      // where the correction was written to, so they *are* it — and if they have
      // been edited since, that is the newer of the two.
      text:
        lines.length > 0
          ? lines.map((line) => line.text).join(' ')
          : (fixed?.speechFix?.text ?? ''),
      ...(fixed?.speechFix?.language ? { language: fixed.speechFix.language } : {}),
      ...(fixed ? { fixedAudioClipId: fixed.id } : {}),
    })
  }

  return targets
}

/** What to call the copy of a clip's voice while it exists. */
export function cloneNameFor(label: string): string {
  // Named after the clip and marked as this app's, so one left behind by a
  // failure — the delete below is best-effort — is recognisable in the user's
  // account rather than being an anonymous voice they dare not remove.
  return `editor-cat fix · ${label}`.slice(0, 100)
}

export interface FixClipAudioOptions {
  /** The clip's media, as stored. Decoded here to take the voice out of it. */
  media: Blob
  /** The stretch of that media the clip uses, in source seconds. */
  inPoint: number
  duration: number
  /**
   * What to say, one caption line at a time and in order.
   *
   * A clip with no captions comes through here as a single line, which is the
   * only difference between the two paths downstream.
   */
  lines: readonly string[]
  /** ISO-639-1, or empty to let the model read the language off the text. */
  language?: string
  /** An ElevenLabs voice to say it in, or empty to copy the clip's own. */
  voiceId?: string
  /** What that voice is called, which only the caller with the list knows. */
  voiceName?: string
  /** The clip's name, which is what a copied voice is called after. */
  label: string
  /** What is happening now, for the status line. */
  onStage?: (stage: string, done: number, total: number) => void
  signal?: AbortSignal
}

/** One line, said. */
export interface SpokenLine {
  text: string
  /** The audio, as MP3. */
  blob: Blob
  /** When each word was said, from the start of this piece. */
  words: SpokenWord[]
}

export interface FixedAudio {
  /** One per line asked for, in the same order. */
  spoken: SpokenLine[]
  /** Who said it, phrased to be read in a sentence about the clip. */
  voiceName: string
}

/** What a run of `fixClipAudio` says it is doing, in the order it does it. */
export const FIX_STAGES = {
  sampling: 'listening to the clip',
  cloning: 'copying the voice',
  speaking: 'saying the lines',
} as const

/**
 * Says a clip's lines properly and hands back the audio for each.
 *
 * One request per caption, not one per clip, and the reason is timing: a caption
 * knows when the picture says its line, so a line that arrives as its own piece
 * of audio can be laid on that mark. One request for the whole clip would come
 * back as a single run of speech that starts right and drifts from there.
 *
 * The lines either side are sent along as context — not spoken, not billed. It
 * costs nothing and is the difference between a passage read aloud and a list of
 * sentences each landing on its own full stop.
 *
 * The voice copy is deleted on the way out however this ends, including on a
 * cancellation: voice slots are finite and shared by everyone this deployment
 * lets in, and nothing here needs the copy a second time — a redo copies the
 * voice again from whatever the clip says by then.
 */
export async function fixClipAudio({
  media,
  inPoint,
  duration,
  lines,
  language,
  voiceId,
  voiceName,
  label,
  onStage,
  signal,
}: FixClipAudioOptions): Promise<FixedAudio> {
  const script = lines.map((line) => line.trim()).filter(Boolean)
  if (script.length === 0) {
    throw new Error('There is nothing to say — type what this clip should be saying.')
  }

  let cloned: string | undefined
  try {
    let speaker = voiceId
    let spokenBy = voiceName || 'an ElevenLabs voice'

    if (!speaker) {
      onStage?.(FIX_STAGES.sampling, 0, script.length)
      const sample = await voiceSample(media, inPoint, duration)
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      onStage?.(FIX_STAGES.cloning, 0, script.length)
      cloned = await cloneVoice({
        name: cloneNameFor(label),
        sample,
        ...(signal ? { signal } : {}),
      })
      speaker = cloned
      spokenBy = 'a copy of its own voice'
    }

    const spoken: SpokenLine[] = []
    for (const [index, text] of script.entries()) {
      onStage?.(FIX_STAGES.speaking, index, script.length)
      const previousText = script[index - 1]
      const nextText = script[index + 1]
      const speech = await speak({
        voiceId: speaker,
        text,
        ...(language ? { languageCode: language } : {}),
        ...(previousText ? { previousText } : {}),
        ...(nextText ? { nextText } : {}),
        ...(signal ? { signal } : {}),
      })
      spoken.push({ text, blob: speech.blob, words: speech.words })
    }

    return { spoken, voiceName: spokenBy }
  } finally {
    if (cloned) {
      // Best effort, and deliberately not awaited into the failure path: the
      // speech is already made or already lost, and neither outcome is improved
      // by reporting that the tidying up also went wrong.
      void deleteVoice(cloned).catch(() => {})
    }
  }
}

/** Where one spoken line ended up, once everything before it had its say. */
export interface PlacedLine {
  start: number
  /** True when the line before it was still talking at its caption's mark. */
  pushed: boolean
  /** True when it came forward to take up room the line before it left unused. */
  pulled: boolean
}

/**
 * Lays the spoken lines out along the timeline.
 *
 * Each wants to start where its caption starts, which is where the picture says
 * it. Two things stop that from being the whole rule, and they pull opposite
 * ways.
 *
 * **Late.** Where the line before has not finished — the new reading is slower
 * than the old performance, or the captions were tight to begin with — this one
 * starts as soon as that one stops. Overlapping was the alternative and it is
 * worse in every way: two voices at once is unlistenable, and one lane cannot
 * hold overlapping clips anyway.
 *
 * **Early.** A caption is as long as the performance took to say it, and a
 * reading is very often quicker — the same words without the hesitation. Left
 * alone, that leaves silence at the tail of the caption, and the next line
 * waiting out a pause the speaker never took. Mid-sentence it does not sound
 * like timing, it sounds like the audio dropped out. So a line may come forward
 * into the room its predecessor did not use, by at most the amount unused.
 *
 * That bound is the point of measuring the shortfall against the caption's own
 * span rather than against wherever the previous line actually landed. A line
 * can be at most one predecessor's shortfall early, however many short readings
 * came before it, so a long clip cannot walk away from its picture — which is
 * the whole reason the lines are spoken and placed one at a time.
 *
 * The run reports both, because both are things to know before hunting for them
 * by ear.
 */
export function layoutSpokenLines(
  lines: readonly { start: number; end: number; duration: number }[],
): PlacedLine[] {
  let previous: { end: number; unused: number } | null = null
  return lines.map((line) => {
    const duration = Math.max(0, line.duration)
    const start = previous
      ? Math.max(previous.end, line.start - previous.unused)
      : // Nothing before it to be late for, and nothing to come forward into.
        line.start
    previous = {
      end: start + duration,
      unused: Math.max(0, Math.max(0, line.end - line.start) - duration),
    }
    return {
      start,
      pushed: start > line.start + TIMING_EPSILON,
      pulled: start < line.start - TIMING_EPSILON,
    }
  })
}

/** Below this, two times are the same time. Rounding, not lateness. */
const TIMING_EPSILON = 0.001

/** The clip's own voice, cut out of its media and wrapped as a WAV. */
async function voiceSample(media: Blob, inPoint: number, duration: number): Promise<Blob> {
  const buffer = await decodeAudio(media)
  const from = Math.max(0, inPoint)
  const to = Math.min(buffer.duration, from + Math.min(duration, CLONE_SAMPLE_SECONDS))
  return await monoWav(buffer, { from, to }, Math.min(buffer.sampleRate, CLONE_SAMPLE_RATE))
}
