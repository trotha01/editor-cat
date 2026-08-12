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
 * ## Why dubbing rather than text-to-speech
 *
 * The obvious way to say the captions again is to say each one as its own
 * text-to-speech request and lay it at its caption's mark. That was the first
 * implementation of this feature and it has one structural weakness: **nothing
 * makes a model say a word at a chosen moment.** A line comes back however long
 * it comes back, so a slower reading pushes the next line late and a quicker one
 * leaves a hole mid-sentence, and the placing rule can only ever redistribute
 * the error rather than remove it.
 *
 * The dubbing API attacks it from the other end. A dubbing project's transcript
 * is a list of **segments** — timed, editable spans — and the speech in a
 * segment is fitted to the span rather than the other way round. So instead of
 * asking for audio and then finding somewhere to put it, this declares where
 * every line goes and asks for audio that fits there.
 *
 * That inverts what the captions are for. In the text-to-speech path a caption
 * supplied a mark to aim at and was then **re-timed to whatever came back**.
 * Here the caption's span is handed to the provider as the segment's span, and
 * what comes back already lands on it.
 *
 * ## The mapping, which is the whole design
 *
 * Dubbing does its own transcription and its own segmentation, and its
 * boundaries have no reason to agree with the user's captions. `planSegments`
 * is where that is resolved, and the rule it applies is the strongest reading of
 * "the captions are the script": **the captions become the segment list,
 * exactly** — one segment per caption, carrying that caption's words and that
 * caption's span, with anything the transcriber found over and above them
 * deleted and anything it missed created. See the comment on `planSegments` for
 * why the pairing is by position rather than by overlap.
 *
 * ## What it costs
 *
 * Three things, all of them real, all of them in the README's limitations:
 *
 *  - **One language for the whole clip.** A project is transcribed in one
 *    language and each target re-says everything in one language, so a bilingual
 *    line is re-said as one or the other and the other half gets the wrong
 *    mouth. This is the fault the feature exists to remove, reintroduced from a
 *    different direction, and it is the largest thing lost.
 *  - **No choice of voice.** Dubbing copies the speaker out of the clip and
 *    offers no way to name one instead, so the ready-made voices the
 *    text-to-speech path offered are simply gone.
 *  - **Speech is rate-adjusted to fit.** A caption whose corrected text no
 *    longer fits its old span is read fast rather than allowed to run over.
 *    `hurriedLines` counts those before the run so the report can name them.
 *  - **The clip has to travel.** Dubbing wants the file, and the file has to
 *    cross a serverless proxy with a payload ceiling; `dubbableSeconds` is that
 *    ceiling in seconds.
 *
 * The clip's own sound is muted and the picture is untouched. Nothing here is
 * lip-sync, and nothing pretends to be; it is the same rhythm, said properly.
 *
 * The provider calls live in `dubbing.ts`. What is here is the choosing — which
 * clips can be fixed, what the dialog opens with, which words land on which
 * segment — plus the cleanup, because a dubbing project left behind sits in the
 * deployment's account holding a copy of the clip.
 */
import {
  alignWords,
  createDubbingProject,
  createLanguageTarget,
  createSegment,
  deleteDubbingProject,
  deleteSegment,
  dubbedAudio,
  updateSegments,
  waitForDub,
  waitForTranscript,
  type SegmentEdit,
} from './dubbing'
import type { SpokenWord } from './elevenlabs'
import { captionCuesOf, cueText } from './captions'
import { decodeAudio, monoWav } from './speechAudio'
import { layoutClips, leadInOf } from './timeline'
import type { Asset, AudioClip, Project } from './types'

/**
 * What a request body may carry, in bytes.
 *
 * The proxy in front of ElevenLabs is a serverless function with a 6MB payload
 * ceiling, and this is deliberately well under it rather than snug against it:
 * the function re-reads the body on its own way through, so a request sized
 * against the ceiling exactly is a request that fails at the ceiling. The same
 * reasoning, and the same headroom, as `CHUNK_SECONDS` in `speechAudio.ts`.
 */
const UPLOAD_BUDGET_BYTES = 4.5 * 1024 * 1024

/**
 * The rate the clip is sent at.
 *
 * Dubbing copies the speaker's voice out of what it is given, and copying a
 * voice listens to timbre, which lives in exactly the high frequencies
 * transcription throws away — so this is not the 16kHz the rest of the app
 * sends. A source that was never this detailed keeps its own rate; upsampling
 * would only make the request bigger.
 */
export const DUB_SAMPLE_RATE = 44100

/**
 * How long a clip may be and still fit through the proxy.
 *
 * This is the ceiling the whole approach runs into, and it is worth being blunt
 * about where it comes from: dubbing wants the media, the media lives in
 * IndexedDB in the browser, and the only way out of the browser is through a
 * function with a payload limit. Audio alone rather than the video, mono rather
 * than stereo, and 16-bit PCM — so a second costs twice the sample rate in
 * bytes, and the budget divided by that is the answer.
 *
 * At 44.1kHz that is under a minute, which covers the generated clips this
 * feature exists for several times over and would not cover a long take. A
 * clip past it is refused with the number in the message rather than sent and
 * rejected upstream.
 */
export function dubbableSeconds(sampleRate = DUB_SAMPLE_RATE): number {
  return Math.floor(UPLOAD_BUDGET_BYTES / (sampleRate * 2))
}

/**
 * One caption under the clip: what it says, and when the picture says it.
 *
 * The unit everything works in. Each of these becomes one segment, spanning
 * exactly this stretch, with exactly these words in it.
 */
export interface FixLine {
  cueId: string
  /** Where the caption starts on the timeline, which is where its segment goes. */
  start: number
  /** Where it ends, which is where its segment ends. */
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
   * A fallback in every sense: one segment across the whole clip, so the fixed
   * generation that makes this worth doing has only the clip's own length to
   * hold the speech to rather than a mark per line. Captioning the clip first is
   * the better road and the dialog says so.
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

/** What to call the dubbing project in the account while it exists. */
export function dubNameFor(label: string): string {
  // Named after the clip and marked as this app's, so one left behind by a
  // failure — the delete below is best-effort — is recognisable in the user's
  // account rather than being an anonymous project they dare not remove. The
  // proxy reads this prefix back before it will delete anything; see
  // `netlify/lib/elevenlabs.ts`.
  return `editor-cat fix · ${label}`.slice(0, 100)
}

/* --- Turning captions into segments --------------------------------------- */

/** A line of the script with the marks the picture puts on it. */
export interface ScriptLine {
  /** Timeline seconds, as the caption has them. */
  start: number
  end: number
  text: string
}

/** What has to happen to the resource before a word is re-said. */
export interface SegmentPlan {
  /** Segments that already exist, rewritten to a caption. */
  update: (SegmentEdit & { id: string })[]
  /** Captions with no segment to put them on. */
  create: SegmentEdit[]
  /** Segments with no caption to put on them. */
  remove: string[]
}

/** Nothing shorter than this is a span. Guards a degenerate caption. */
const MIN_SEGMENT_SECONDS = 0.05

/**
 * Rewrites the resource's segments as the clip's captions.
 *
 * The crux of this implementation. Dubbing transcribed the clip and split it
 * into spans on its own judgement; the app's design says the user's captions are
 * the script. Those two are reconciled here, and completely rather than
 * partially: after this plan is applied the resource holds one segment per
 * caption, each spanning that caption and saying that caption's words, and
 * nothing else at all.
 *
 * **Paired by position, not by overlap.** The obvious alternative is to match
 * each segment to the caption it overlaps most. It was not chosen, for two
 * reasons. The segments come from transcribing the very audio the captions were
 * transcribed from, so wherever both are sane their orders already agree and
 * overlap-matching computes the same answer more slowly. Where they do not
 * agree, overlap-matching fails in the worse direction: it leaves some segment
 * unmatched, and an unmatched segment keeps the words the transcriber gave it
 * and is then dubbed and rendered — the clip saying something the user never
 * typed. Pairing by position cannot do that, because every segment is either
 * rewritten or removed.
 *
 * Times are converted from the timeline's clock to the media's on the way
 * through: the uploaded audio is this clip and nothing else, so the two differ
 * by exactly where the clip starts. Everything is clamped into the clip, which
 * matters for the last caption — a caption may legitimately run past the end of
 * the shot it belongs to, and a segment may not.
 */
export function planSegments(
  lines: readonly ScriptLine[],
  segments: readonly { id: string }[],
  { clipStart, duration }: { clipStart: number; duration: number },
): SegmentPlan {
  const edits = lines.map((line): SegmentEdit => {
    const start = clamp(line.start - clipStart, 0, duration)
    const end = clamp(Math.max(line.end - clipStart, start + MIN_SEGMENT_SECONDS), start, duration)
    return { start, end, text: line.text }
  })

  return {
    update: edits.flatMap((edit, index) => {
      const id = segments[index]?.id
      return id ? [{ ...edit, id }] : []
    }),
    create: edits.slice(segments.length),
    remove: segments.slice(edits.length).map((segment) => segment.id),
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}

/**
 * A comfortable reading pace, in characters a second.
 *
 * Speech runs at something like twelve to sixteen characters a second across
 * the languages this offers. The number is only ever used to decide whether to
 * warn, so what matters is that it sits at the top of ordinary rather than in
 * the middle of it: warning about every line would be the same as warning about
 * none.
 */
const COMFORTABLE_CHARS_PER_SECOND = 17

/**
 * The lines that will have to be read fast to fit the span they were given.
 *
 * The price of fixed generation, made visible before it is paid. A segment's
 * duration is held and the speech inside it is compressed to fit, so a caption
 * whose corrected text is much longer than what was originally said there comes
 * back gabbled rather than late. That is a better failure than the
 * text-to-speech path's — nothing drifts, and nothing lands on the line after it
 * — but it is still a failure, and it is invisible unless something counts it.
 *
 * The remedy is the same either way and the report says so: shorten the line, or
 * give that caption more room.
 */
export function hurriedLines(edits: readonly SegmentEdit[]): { count: number; peak: number } {
  const rates = edits.flatMap((edit) => {
    const span = edit.end - edit.start
    const characters = edit.text.trim().length
    return span > 0 && characters > 0 ? [characters / span] : []
  })
  const hurried = rates.filter((rate) => rate > COMFORTABLE_CHARS_PER_SECOND)
  return { count: hurried.length, peak: Math.max(0, ...rates) }
}

/**
 * Hands each line the words that belong to it.
 *
 * Forced alignment is run once over the whole rendered track with the whole
 * script, because that is the only way it can hear a word's neighbours — and it
 * comes back as one flat run of words. The captions need them line by line, and
 * the split is by count rather than by time: the script was assembled from these
 * very lines, so the first line owns the first *n* words for its own *n*, and no
 * arithmetic on timestamps can be more right than that.
 *
 * A short answer is truncated rather than redistributed. If alignment returns
 * fewer words than were sent, the lines that got some are still correctly timed
 * and the ones that got none are simply left alone by the caller — which is
 * better than every line being confidently wrong.
 */
export function splitAlignedWords(
  lines: readonly string[],
  words: readonly SpokenWord[],
): SpokenWord[][] {
  let cursor = 0
  return lines.map((line) => {
    const wanted = line.trim().split(/\s+/).filter(Boolean).length
    const slice = words.slice(cursor, cursor + wanted)
    cursor += wanted
    return [...slice]
  })
}

/* --- Running one --------------------------------------------------------- */

export interface FixClipAudioOptions {
  /** The clip's media, as stored. Decoded here to send its sound over. */
  media: Blob
  /** The stretch of that media the clip uses, in source seconds. */
  inPoint: number
  duration: number
  /** Where the clip starts on the timeline, which the captions are measured in. */
  clipStart: number
  /**
   * What to say, one caption at a time and in order, each with its own marks.
   *
   * A clip with no captions comes through here as a single line spanning the
   * clip, which is the only difference between the two paths downstream.
   */
  lines: readonly ScriptLine[]
  /** BCP-47. Required: a dub has one target language and no detect option. */
  language: string
  /** The clip's name, which is what the dubbing project is called after. */
  label: string
  /** What is happening now, for the status line. */
  onStage?: (stage: string, done: number, total: number) => void
  signal?: AbortSignal
}

export interface FixedAudio {
  /** The whole corrected clip, as one piece of MP3. */
  blob: Blob
  /** Per line asked for, in the same order: the words, timed from the track. */
  lines: { text: string; words: SpokenWord[] }[]
  /** Who said it, phrased to be read in a sentence about the clip. */
  voiceName: string
  /** Lines that had to be read fast to fit their caption. */
  hurried: { count: number; peak: number }
}

/** What a run of `fixClipAudio` says it is doing, in the order it does it. */
export const FIX_STAGES = {
  sampling: 'listening to the clip',
  uploading: 'sending it to be dubbed',
  transcribing: 'finding the lines in it',
  scripting: 'putting your words on them',
  speaking: 'saying them again',
  fetching: 'bringing it back',
  aligning: 'finding the words in it',
} as const

/**
 * Says a clip's lines properly and hands back the corrected track.
 *
 * One job for the whole clip, not one request per caption, and the reason is the
 * one in the module header: a segment holds its span, so the timing is declared
 * up front rather than discovered afterwards. What comes back is a single piece
 * of audio in which every line is already where its caption is.
 *
 * The job is deleted on the way out however this ends, including on a
 * cancellation. A dubbing project holds a copy of the clip's media in the
 * deployment's account and there is nothing here that needs it a second time —
 * a redo dubs the clip again from whatever it says by then.
 */
export async function fixClipAudio({
  media,
  inPoint,
  duration,
  clipStart,
  lines,
  language,
  label,
  onStage,
  signal,
}: FixClipAudioOptions): Promise<FixedAudio> {
  const script = lines.flatMap((line) =>
    line.text.trim() ? [{ ...line, text: line.text.trim() }] : [],
  )
  if (script.length === 0) {
    throw new Error('There is nothing to say — type what this clip should be saying.')
  }
  if (!language) {
    throw new Error('Pick the language this clip should be said in — dubbing has to be told one.')
  }

  const total = script.length
  const stage = (name: string, done = 0) => onStage?.(name, done, total)

  stage(FIX_STAGES.sampling)
  const audio = await clipAudio(media, inPoint, duration)
  abortIfAsked(signal)

  let projectId: string | undefined
  try {
    stage(FIX_STAGES.uploading)
    projectId = await createDubbingProject({
      audio,
      reference: dubNameFor(label),
      language,
      seconds: duration,
      ...(signal ? { signal } : {}),
    })

    stage(FIX_STAGES.transcribing)
    const transcript = await waitForTranscript(projectId, { ...(signal ? { signal } : {}) })

    stage(FIX_STAGES.scripting)
    const plan = planSegments(script, transcript.segments, { clipStart, duration })
    await applyPlan(projectId, plan, {
      // Every segment the transcriber found belongs to some speaker, and a new
      // one has to name a speaker that already exists. The first is the right
      // one: a clip is one shot of one person talking, and where dubbing has
      // heard two it has split one voice rather than found two.
      speakerId: transcript.segments[0]?.speakerId,
      ...(signal ? { signal } : {}),
      onLine: (done) => stage(FIX_STAGES.scripting, done),
    })

    // Only now. A language target created any earlier starts from the words the
    // transcriber heard rather than the ones the user typed — see `dubbing.ts`.
    stage(FIX_STAGES.speaking)
    const languageId = await createLanguageTarget(projectId, language, signal)
    const url = await waitForDub(projectId, languageId, { ...(signal ? { signal } : {}) })

    stage(FIX_STAGES.fetching)
    const blob = await dubbedAudio(url, signal)

    stage(FIX_STAGES.aligning)
    const texts = script.map((line) => line.text)
    // Failing to time the words is not failing to fix the clip. The audio is
    // made and paid for by this point, and the only thing lost is the karaoke
    // highlight moving onto it — so the captions keep the timings they had
    // rather than the whole run being thrown away over the last request in it.
    const words = await alignWords(blob, texts.join(' '), signal).catch(() => [])

    return {
      blob,
      lines: splitAlignedWords(texts, words).map((wordsForLine, index) => ({
        text: texts[index] ?? '',
        words: wordsForLine,
      })),
      voiceName: 'a copy of its own voice',
      hurried: hurriedLines([...plan.update, ...plan.create]),
    }
  } finally {
    if (projectId) {
      // Best effort, and deliberately not awaited into the failure path: the
      // audio is already made or already lost, and neither outcome is improved
      // by reporting that the tidying up also went wrong.
      void deleteDubbingProject(projectId).catch(() => {})
    }
  }
}

/**
 * Writes the plan onto the project's transcript.
 *
 * Removals go last on purpose. A transcript with no segments at all is one
 * dubbing may decide has nothing in it, and emptying it before refilling it
 * would pass through that state on every run where the captions are fewer than
 * the transcriber's spans — which is most of them, since a caption is usually a
 * whole sentence and a span is usually a breath.
 *
 * The rewrites go in one request rather than one each: they are one script being
 * written in, so sending them together is fewer round trips and one revision
 * bump instead of a run of them.
 */
async function applyPlan(
  projectId: string,
  plan: SegmentPlan,
  {
    speakerId,
    signal,
    onLine,
  }: {
    speakerId?: string
    signal?: AbortSignal
    onLine?: (done: number) => void
  },
): Promise<void> {
  await updateSegments(
    projectId,
    Object.fromEntries(plan.update.map(({ id, ...edit }) => [id, edit])),
    signal,
  )
  let done = plan.update.length
  onLine?.(done)

  for (const edit of plan.create) {
    // Without a speaker there is nothing to hang a new segment on. The lines
    // that did fit existing segments are still said correctly, so this stops
    // rather than throws — losing four of five corrected lines because the
    // fifth had nowhere to go would be the worse trade.
    if (!speakerId) break
    await createSegment(projectId, speakerId, edit, signal)
    onLine?.((done += 1))
  }

  for (const id of plan.remove) {
    await deleteSegment(projectId, id, signal)
  }
}

function abortIfAsked(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
}

/**
 * The clip's own sound, cut out of its media and wrapped as a WAV.
 *
 * The whole clip rather than a sample of it, which is the difference from what
 * the text-to-speech path sent: that only needed enough of the voice to copy it,
 * and this is the audio actually being re-voiced, so a second missing from the
 * end is a second of the clip that does not get fixed.
 */
async function clipAudio(media: Blob, inPoint: number, duration: number): Promise<Blob> {
  const buffer = await decodeAudio(media)
  const rate = Math.min(buffer.sampleRate, DUB_SAMPLE_RATE)
  const limit = dubbableSeconds(rate)
  if (duration > limit) {
    throw new Error(
      `This clip is ${Math.round(duration)}s long, and a clip has to be under ${limit}s to be ` +
        `dubbed — that is as much audio as fits through this site's upload limit. Split the clip ` +
        `and fix the halves separately.`,
    )
  }

  const from = Math.max(0, inPoint)
  const to = Math.min(buffer.duration, from + duration)
  return await monoWav(buffer, { from, to }, rate)
}
