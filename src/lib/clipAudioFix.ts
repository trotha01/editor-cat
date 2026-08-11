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
 * So the line is said again from the text. ElevenLabs is handed three things:
 * the clip's own audio, to copy the speaker's voice from; the words, spelled the
 * way they should be said; and, when the line is all one language, which
 * language that is. What comes back is laid on a voice track under the clip and
 * the clip's own sound is muted — the picture is untouched, and the mouth on
 * screen is still moving to the same rhythm, which is as close to lip-sync as
 * anything short of regenerating the shot will get.
 *
 * The provider calls live in `elevenlabs.ts`. What is here is the choosing —
 * which clips can be fixed, what the box should already say when it opens, and
 * the order the two requests go in — plus the cleanup, because copying a voice
 * leaves one behind in the user's account until it is deleted.
 */
import { cloneVoice, deleteVoice, speak } from './elevenlabs'
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
   * What the text box opens with: the last correction made here, or failing
   * that whatever this clip's captions say was heard.
   *
   * Captions are the useful default because they are already the words of this
   * clip, transcribed from this clip — and the one thing wrong with them is
   * usually the one thing wrong with the audio, so what needs retyping is
   * exactly the part that needs fixing. Empty when there is neither.
   */
  text: string
  /** The language a previous fix enforced, so a redo defaults to the same one. */
  language?: string
  /** Audio a previous fix left under this clip. A new one replaces it. */
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

  const fixes = new Map<string, AudioClip>()
  for (const clip of project.audioClips ?? []) {
    if (clip.speechFix && clip.anchorClipId) fixes.set(clip.anchorClipId, clip)
  }

  const heard = new Map<string, string[]>()
  for (const cue of [...captionCuesOf(project)].sort((a, b) => a.start - b.start)) {
    if (!cue.source) continue
    const words = heard.get(cue.source.id) ?? []
    words.push(cueText(cue))
    heard.set(cue.source.id, words)
  }

  const targets = new Map<string, FixTarget>()
  for (const positioned of layoutClips(project.clips, leadInOf(project))) {
    const asset = assetById.get(positioned.clip.assetId)
    if (asset?.kind !== 'video' || !(positioned.duration > 0)) continue

    const fixed = fixes.get(positioned.clip.id)
    targets.set(positioned.clip.id, {
      clipId: positioned.clip.id,
      label: asset.name,
      assetId: asset.id,
      startTime: positioned.start,
      inPoint: positioned.clip.inPoint,
      duration: positioned.duration,
      text: fixed?.speechFix?.text ?? heard.get(positioned.clip.id)?.join(' ') ?? '',
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
  key: string
  /** The clip's media, as stored. Decoded here to take the voice out of it. */
  media: Blob
  /** The stretch of that media the clip uses, in source seconds. */
  inPoint: number
  duration: number
  /** What the clip should say, spelled the way it should be said. */
  text: string
  /** ISO-639-1, or empty to let the model read the language off the text. */
  language?: string
  /** An ElevenLabs voice to say it in, or empty to copy the clip's own. */
  voiceId?: string
  /** What that voice is called, which only the caller with the list knows. */
  voiceName?: string
  /** The clip's name, which is what a copied voice is called after. */
  label: string
  /** What is happening now, for the status line. */
  onStage?: (stage: string) => void
  signal?: AbortSignal
}

export interface FixedAudio {
  /** The corrected line, as MP3. */
  blob: Blob
  /** Who said it, phrased to be read in a sentence about the clip. */
  voiceName: string
}

/** What a run of `fixClipAudio` says it is doing, in the order it does it. */
export const FIX_STAGES = {
  sampling: 'listening to the clip',
  cloning: 'copying the voice',
  speaking: 'saying the line',
} as const

/**
 * Says a clip's line properly and hands back the audio.
 *
 * Two requests where the voice is being copied, one where it is being chosen.
 * The copy is deleted on the way out however this ends, including on a
 * cancellation: a voice left behind counts against the user's own slot limit,
 * and nothing here needs it a second time — a redo copies the voice again from
 * whatever the clip says by then.
 */
export async function fixClipAudio({
  key,
  media,
  inPoint,
  duration,
  text,
  language,
  voiceId,
  voiceName,
  label,
  onStage,
  signal,
}: FixClipAudioOptions): Promise<FixedAudio> {
  const line = text.trim()
  if (!line) throw new Error('There is nothing to say — type what this clip should be saying.')

  let cloned: string | undefined
  try {
    let speaker = voiceId
    let spokenBy = voiceName || 'an ElevenLabs voice'

    if (!speaker) {
      onStage?.(FIX_STAGES.sampling)
      const sample = await voiceSample(media, inPoint, duration)
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      onStage?.(FIX_STAGES.cloning)
      cloned = await cloneVoice({
        key,
        name: cloneNameFor(label),
        sample,
        ...(signal ? { signal } : {}),
      })
      speaker = cloned
      spokenBy = 'a copy of its own voice'
    }

    onStage?.(FIX_STAGES.speaking)
    const blob = await speak({
      key,
      voiceId: speaker,
      text: line,
      ...(language ? { languageCode: language } : {}),
      ...(signal ? { signal } : {}),
    })

    return { blob, voiceName: spokenBy }
  } finally {
    if (cloned) {
      // Best effort, and deliberately not awaited into the failure path: the
      // speech is already made or already lost, and neither outcome is improved
      // by reporting that the tidying up also went wrong.
      void deleteVoice(key, cloned).catch(() => {})
    }
  }
}

/** The clip's own voice, cut out of its media and wrapped as a WAV. */
async function voiceSample(media: Blob, inPoint: number, duration: number): Promise<Blob> {
  const buffer = await decodeAudio(media)
  const from = Math.max(0, inPoint)
  const to = Math.min(buffer.duration, from + Math.min(duration, CLONE_SAMPLE_SECONDS))
  return await monoWav(buffer, { from, to }, Math.min(buffer.sampleRate, CLONE_SAMPLE_RATE))
}
