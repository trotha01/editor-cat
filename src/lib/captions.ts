/**
 * Karaoke captions: grouping words into cues, and every edit you can make to
 * them afterwards.
 *
 * All of it is pure. Caption bugs are timing bugs — a word that highlights a
 * beat late, a cue that swallows its neighbour, a retime that quietly drops the
 * last word — and none of those are visible in a screenshot, so the arithmetic
 * lives here, free of React and IO, and is asserted on directly.
 *
 * Two rules hold everywhere below and are what keep the model coherent:
 *
 *  - Word times are absolute timeline seconds, never offsets into a cue. Moving
 *    a cue moves its words with it, and there is no second representation to
 *    fall out of step.
 *  - Words within a cue are sorted and never overlap. Retiming one clamps it
 *    against its neighbours rather than reordering them, so the word being
 *    highlighted always advances left to right the way it is read.
 */
import type { CaptionCue, CaptionSource, CaptionStyle, CaptionTrack, CaptionWord } from './types'

/** Shortest a word may be held, in seconds. Below this the highlight flickers. */
export const MIN_WORD_DURATION = 0.04

/** Shortest a cue may be. A caption you cannot read is not a caption. */
export const MIN_CUE_DURATION = 0.2

/** Slack for comparing times. Far below one frame at any usable rate. */
const EPSILON = 1e-6

/**
 * The typeface shipped for captions, by family name.
 *
 * The same string names the CSS family in the preview and the ASS style in the
 * export, which is the point: one name, one set of files, one look. See
 * scripts/copy-caption-font.mjs.
 */
export const CAPTION_FONT_FAMILY = 'Inter Captions'

/**
 * Where the caption font files are served from.
 *
 * The export reads them over the network at render time rather than bundling
 * them, so a project with no captions never pays for 700KB of glyphs.
 */
export const CAPTION_FONT_URLS = {
  regular: '/fonts/Inter-Regular.ttf',
  bold: '/fonts/Inter-Bold.ttf',
} as const

/**
 * Big and bold, low in the frame.
 *
 * These defaults are the short-form caption look: heavy weight, generous size,
 * a hard outline so the text survives whatever is behind it, and a yellow
 * highlight that reads at a glance as "this word, now". Everything is a
 * fraction of the frame so it holds up at any export resolution.
 */
export function defaultCaptionStyle(): CaptionStyle {
  return {
    // Roughly a tenth of the frame height: large enough to read on a phone held
    // at arm's length, small enough that three or four words still fit a line.
    fontScale: 0.075,
    bold: true,
    uppercase: false,
    color: '#ffffff',
    highlightColor: '#ffd60a',
    outlineColor: '#000000',
    outlineScale: 0.09,
    // Clear of the bottom edge, where a phone's own UI sits.
    position: 0.82,
  }
}

export function createCaptionTrack(id: string, name = 'Captions'): CaptionTrack {
  return { id, name, hidden: false, style: defaultCaptionStyle() }
}

/**
 * What a project with no captions has, which is most of them.
 *
 * One shared value rather than a fresh `[]` per call, and that is load-bearing:
 * these are read inside store selectors, which compare by identity. A new empty
 * array every time reads as a change every time, and the render loop that
 * follows takes the whole page down.
 */
const NO_TRACKS: readonly CaptionTrack[] = []
const NO_CUES: readonly CaptionCue[] = []

/** A project's caption tracks, guarded. Absent — most projects — is none. */
export function captionTracksOf(project: {
  captionTracks?: CaptionTrack[]
}): readonly CaptionTrack[] {
  return project.captionTracks ?? NO_TRACKS
}

/** A project's cues, guarded. */
export function captionCuesOf(project: { captionCues?: CaptionCue[] }): readonly CaptionCue[] {
  return project.captionCues ?? NO_CUES
}

/** When the last caption leaves the screen, in seconds. */
export function captionsEnd(cues: readonly CaptionCue[]): number {
  return cues.reduce((max, cue) => Math.max(max, cue.end), 0)
}

/** Cues on one track, in the order they play. */
export function cuesOnTrack(cues: readonly CaptionCue[], trackId: string): CaptionCue[] {
  return cues.filter((cue) => cue.trackId === trackId).sort((a, b) => a.start - b.start)
}

// --- Reading the model at a moment in time ---------------------------------

/**
 * The cue on screen at `t`, or null between cues.
 *
 * Half-open, so a cue ending exactly where the next begins hands over cleanly
 * rather than both being on screen for one frame.
 */
export function cueAtTime(cues: readonly CaptionCue[], t: number): CaptionCue | null {
  return cues.find((cue) => t >= cue.start && t < cue.end) ?? null
}

/**
 * Which word is highlighted at `t`, as an index into the cue, or -1 for none.
 *
 * A word stays lit until the next one starts rather than going dark at its own
 * end. People pause between words, and a highlight that blinks off in every gap
 * reads as a fault rather than as silence. Before the first word starts nothing
 * is lit, which is what gives a cue its beat of lead-in.
 */
export function activeWordIndexAt(cue: CaptionCue, t: number): number {
  let active = -1
  for (let index = 0; index < cue.words.length; index += 1) {
    const word = cue.words[index]
    if (!word || word.start > t + EPSILON) break
    active = index
  }
  // Past the cue itself nothing is highlighted, so a held caption does not sit
  // there with its last word still lit after the line has been spoken.
  if (t >= cue.end) return -1
  return active
}

/**
 * The stretch of time each word owns, which is what the highlight follows.
 *
 * Runs from the word's own start to wherever the next word begins (or the end of
 * the cue for the last one), so the spans tile the cue with no gaps. This is the
 * single definition of "which word now" — the preview reads it, and the exporter
 * turns each span into one subtitle event, so the two cannot disagree.
 */
export interface WordSpan {
  index: number
  word: CaptionWord
  start: number
  end: number
}

export function wordSpans(cue: CaptionCue): WordSpan[] {
  const spans: WordSpan[] = []
  cue.words.forEach((word, index) => {
    const start = Math.max(cue.start, word.start)
    const next = cue.words[index + 1]
    const end = Math.min(cue.end, next ? Math.max(start, next.start) : cue.end)
    if (end > start + EPSILON) spans.push({ index, word, start, end })
  })
  return spans
}

/** The cue's words as a plain sentence, which is what the transcript editor shows. */
export function cueText(cue: CaptionCue): string {
  return cue.words.map((word) => word.text).join(' ')
}

/** The whole transcript, one cue per line. */
export function transcriptText(cues: readonly CaptionCue[]): string {
  return cues.map(cueText).join('\n')
}

// --- Building cues out of a transcript --------------------------------------

/** A word as the transcriber gave it, already mapped onto the timeline. */
export interface TimedWord {
  text: string
  start: number
  end: number
  /**
   * Which clip this was heard in. Carried from `wordsOntoTimeline` through
   * grouping so the caption that comes out can say where it came from.
   */
  source?: CaptionSource
}

export interface GroupOptions {
  /** Hard ceiling on words per caption, so a line never runs off the frame. */
  maxWords: number
  /** A silence at least this long starts a new caption. */
  maxGap: number
  /** Longest a single caption may run, however few words it holds. */
  maxSeconds: number
  /**
   * A caption is held until the next one starts if the gap between them is
   * shorter than this.
   *
   * Without it, a line ends on its last word and the next begins on its first,
   * leaving the screen blank for the breath between them — a tenth of a second
   * of nothing, over and over, which reads as a fault rather than as a pause.
   * A gap longer than this is a real pause and is left alone: the screen
   * clearing is the right thing when someone has actually stopped talking.
   */
  holdThroughGap: number
}

/**
 * Three or four words at a time is the short-form caption rhythm: enough to read
 * as a phrase, few enough that the highlighted word is never hunting.
 */
export const DEFAULT_GROUPING: GroupOptions = {
  maxWords: 4,
  maxGap: 0.6,
  maxSeconds: 3.5,
  holdThroughGap: 0.7,
}

/**
 * Groups a flat run of timed words into cues.
 *
 * Breaks on three things, in the order a listener would: the end of a sentence,
 * a pause long enough to be one, and then simply having enough words on screen.
 * Punctuation is kept on the word — it is part of what was said and belongs in
 * the caption — but it is also what tells us where a line ends.
 *
 * `makeId` is injected so this stays pure and testable.
 */
export function cuesFromWords(
  words: readonly TimedWord[],
  trackId: string,
  makeId: (prefix: string) => string,
  options: GroupOptions = DEFAULT_GROUPING,
): CaptionCue[] {
  const cues: CaptionCue[] = []
  let current: CaptionWord[] = []
  // The clip the group started in. A caption that runs across a cut is credited
  // to where it begins, which is the honest answer to "where is this from" and
  // the one that stays stable when the words either side are re-edited.
  let source: CaptionSource | undefined

  const flush = () => {
    if (current.length === 0) return
    cues.push(cueFromWords(current, trackId, makeId('cue'), source))
    current = []
    source = undefined
  }

  for (const word of words) {
    const text = word.text.trim()
    if (!text) continue

    const first = current[0]
    const previous = current[current.length - 1]
    const gap = previous ? word.start - previous.end : 0
    const span = first ? word.end - first.start : 0

    if (
      current.length >= options.maxWords ||
      (previous && gap >= options.maxGap) ||
      (first && span > options.maxSeconds)
    ) {
      flush()
    }

    source ??= word.source
    current.push({
      id: makeId('word'),
      text,
      start: word.start,
      // A transcriber can hand back a zero-length word; give it something to be
      // highlighted for rather than letting it be skipped over.
      end: Math.max(word.end, word.start + MIN_WORD_DURATION),
    })

    if (endsSentence(text)) flush()
  }

  flush()
  return closeSeams(cues, options.holdThroughGap)
}

/**
 * Makes each caption meet the next one exactly, where they are close.
 *
 * Two problems, one answer. A caption that ends a breath before the next begins
 * leaves the screen blank for a tenth of a second, over and over, which reads as
 * a fault rather than as a pause. A caption that *overlaps* the next — which
 * happens when a transcriber times two words as running together across a
 * sentence break, and again whenever a one-word caption is padded up to the
 * minimum length — is worse: only one can be on screen, so the preview shows one
 * and the export stacks both.
 *
 * Setting the end to the next start fixes both, and leaves a real pause alone.
 */
function closeSeams(cues: CaptionCue[], threshold: number): CaptionCue[] {
  return cues.map((cue, index) => {
    const next = cues[index + 1]
    if (!next) return cue
    const gap = next.start - cue.end
    return gap < threshold ? { ...cue, end: Math.max(cue.start, next.start) } : cue
  })
}

/** True for a word that ends a sentence, which is always a caption break. */
function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text)
}

/** Wraps a run of words into a cue spanning exactly them. */
function cueFromWords(
  words: CaptionWord[],
  trackId: string,
  id: string,
  source?: CaptionSource,
): CaptionCue {
  const start = words[0]?.start ?? 0
  const last = words[words.length - 1]
  return {
    id,
    trackId,
    start,
    end: Math.max(start + MIN_CUE_DURATION, last?.end ?? start),
    words,
    ...(source ? { source } : {}),
  }
}

/**
 * How much of a word may sit under one already taken before it is treated as
 * the same moment being transcribed twice.
 */
const DUPLICATE_OVERLAP = 0.5

/**
 * Resolves speech that happens at the same time from more than one source.
 *
 * Takes layer: recording a line twice leaves two voice tracks both carrying it,
 * both audible, and both transcribed. Merging those word for word gives "This
 * This is is a a", which is not a caption of anything. Only one word can be
 * highlighted at a time, so only one word can be captioned at a time, and the
 * one kept is whichever source comes first — the same order the panel reports
 * progress in, and the one the user can change by muting a track.
 *
 * Words are only dropped when they genuinely sit on top of one already taken.
 * Speech runs together, and transcribers hand back words that touch or overlap
 * slightly, so the test is proportional: more than half of this word is already
 * spoken for.
 *
 * Expects `words` sorted by start, which is what `transcribeTimeline` produces.
 */
export function dedupeOverlappingWords(words: readonly TimedWord[]): TimedWord[] {
  const kept: TimedWord[] = []
  for (const word of words) {
    const last = kept[kept.length - 1]
    const length = Math.max(word.end - word.start, MIN_WORD_DURATION)
    const covered = last ? Math.min(word.end, last.end) - word.start : 0
    if (covered / length > DUPLICATE_OVERLAP) continue
    kept.push(word)
  }
  return kept
}

/**
 * Moves a transcriber's word times — which are relative to the audio file — onto
 * the timeline, and drops anything outside the part of the file the clip uses.
 *
 * A clip trimmed to its middle plays neither the words before its in-point nor
 * the ones after it runs out, so captioning them would put text on screen for
 * audio nobody hears.
 */
export function wordsOntoTimeline(
  words: readonly TimedWord[],
  clip: { startTime: number; inPoint: number; duration: number; id?: string; label?: string },
): TimedWord[] {
  const from = clip.inPoint
  const to = clip.inPoint + clip.duration
  const offset = clip.startTime - clip.inPoint

  // Stamped here rather than anywhere later because this is the only point that
  // knows both the words and the clip they were heard in — afterwards they are
  // sorted in among everybody else's and the connection is gone.
  const source: CaptionSource | undefined =
    clip.id === undefined ? undefined : { id: clip.id, label: clip.label ?? clip.id }

  return words
    .filter((word) => word.end > from + EPSILON && word.start < to - EPSILON)
    .map((word) => ({
      text: word.text,
      // Clamped, so a word straddling the edit is held for as long as it is
      // actually audible rather than for its full length.
      start: Math.max(from, word.start) + offset,
      end: Math.min(to, word.end) + offset,
      ...(source ? { source } : {}),
    }))
}

/** What redoing one clip's captions did, counted so the panel can say it out loud. */
export interface Recaption {
  /** Every cue the project should now hold, the swap applied. */
  cues: CaptionCue[]
  /** What the clip has just produced, as it landed. */
  fresh: CaptionCue[]
  /** Captions from that clip that were thrown away to make room for them. */
  replaced: number
  /** Captions the clip produced that had nowhere to go. Never silent — see below. */
  dropped: number
}

/**
 * Replaces the captions transcribed from one clip, and only those.
 *
 * "Redo captions" transcribes the whole timeline and replaces the lot, which is
 * right when the transcript is bad everywhere and wrong when one clip is bad and
 * the rest has been corrected by hand: you pay to transcribe what was already
 * right, and lose the corrections into the bargain. This is the other half of
 * that button. One clip's words come back; every other line stays exactly as it
 * was, down to its identity, so nothing edited elsewhere can be disturbed.
 *
 * Which captions belong to the clip is `cue.source`, stamped when the transcript
 * was made. A caption that claims no source — typed by hand, or made before
 * provenance was recorded — belongs to nobody and is never swapped out.
 *
 * The fresh captions defer to the ones that stayed: each is pulled inside the
 * room left between its neighbours, and one with no room at all is dropped
 * rather than laid over a caption from another clip. Deferring is the whole
 * point of doing one clip at a time — a redo asked for on clip A must not move a
 * word on clip B — and it is the same resolution `dedupeOverlappingWords` makes
 * when both clips are transcribed at once, which is what stops the two paths
 * disagreeing about layered takes. What was dropped is counted and handed back,
 * because a caption quietly missing is exactly what nobody would think to look
 * for.
 */
export function recaptionSource(
  cues: readonly CaptionCue[],
  trackId: string,
  sourceId: string,
  words: readonly TimedWord[],
  makeId: (prefix: string) => string,
  options: GroupOptions = DEFAULT_GROUPING,
): Recaption {
  const kept = cues.filter((cue) => cue.trackId !== trackId || cue.source?.id !== sourceId)
  const grouped = cuesFromWords(words, trackId, makeId, options)
  // Fitted one at a time against `kept` alone: `cuesFromWords` already leaves no
  // overlap within its own output, and fitting only ever shrinks a cue, so the
  // two sets together still hold one caption on screen at a time.
  const fresh = grouped
    .map((cue) => fitBetweenNeighbours(cue, kept))
    .filter((cue) => cue.end - cue.start >= MIN_CUE_DURATION - EPSILON)

  return {
    cues: [...kept, ...fresh],
    fresh,
    replaced: cues.length - kept.length,
    dropped: grouped.length - fresh.length,
  }
}

// --- Editing -----------------------------------------------------------------

/**
 * Sorts a cue's words and pushes coincident ones apart, preserving reading
 * order.
 *
 * Only the starts are forced apart, not the ends: words are allowed to run into
 * each other — running speech does — but two words starting at the same instant
 * would leave the highlight with no defined position, so each start is nudged
 * clear of the one before it.
 */
function normalizeWords(words: readonly CaptionWord[]): CaptionWord[] {
  const sorted = [...words].sort((a, b) => a.start - b.start)
  let cursor = -Infinity
  return sorted.map((word) => {
    const start = Math.max(word.start, cursor)
    const end = Math.max(word.end, start + MIN_WORD_DURATION)
    cursor = start + MIN_WORD_DURATION
    return { ...word, start, end }
  })
}

/** A cue with its bounds widened to hold every word it contains. */
function withBounds(cue: CaptionCue, words: CaptionWord[]): CaptionCue {
  const first = words[0]
  const last = words[words.length - 1]
  const start = Math.min(cue.start, first?.start ?? cue.start)
  const end = Math.max(cue.end, last?.end ?? cue.end, start + MIN_CUE_DURATION)
  return { ...cue, start, end, words }
}

/**
 * Retimes a word, clamped so it stays between its neighbours.
 *
 * Refusing to reorder is deliberate: dragging one word past the next would
 * change which word is read first, which is never what dragging a handle means.
 */
export function setWordTiming(
  cue: CaptionCue,
  wordId: string,
  patch: { start?: number; end?: number },
): CaptionCue {
  const index = cue.words.findIndex((word) => word.id === wordId)
  const word = cue.words[index]
  if (!word) return cue

  const previous = cue.words[index - 1]
  const next = cue.words[index + 1]

  const lowerBound = previous ? previous.start + MIN_WORD_DURATION : cue.start
  const upperBound = next ? next.start - MIN_WORD_DURATION : cue.end

  const start =
    patch.start === undefined
      ? word.start
      : clamp(patch.start, lowerBound, Math.max(lowerBound, upperBound - MIN_WORD_DURATION))

  const end =
    patch.end === undefined
      ? Math.max(word.end, start + MIN_WORD_DURATION)
      : clamp(patch.end, start + MIN_WORD_DURATION, Math.max(start + MIN_WORD_DURATION, cue.end))

  const words = cue.words.map((entry) => (entry.id === wordId ? { ...entry, start, end } : entry))
  return withBounds(cue, words)
}

/**
 * Moves a cue in time, taking its words with it.
 *
 * The whole line shifts by one delta rather than being re-spread across the new
 * span, because a caption that is simply late is the common case and rescaling
 * it would destroy timings that were already right relative to each other.
 */
export function moveCue(cue: CaptionCue, startTime: number): CaptionCue {
  const start = Math.max(0, startTime)
  const delta = start - cue.start
  if (Math.abs(delta) < EPSILON) return cue
  return {
    ...cue,
    start,
    end: cue.end + delta,
    words: cue.words.map((word) => ({
      ...word,
      start: word.start + delta,
      end: word.end + delta,
    })),
  }
}

/**
 * Drags one end of a cue.
 *
 * Only the bounds move. Words are left exactly where they are, which matters
 * more than it looks: a drag applies this once per pointer event, to the cue as
 * it already stands, so anything that moved the words would compound — overshoot
 * an edge and correct it inside one gesture and you would have squashed the line
 * permanently, with no undo to reach for. Leaving them alone makes the whole
 * drag reversible by dragging back.
 *
 * A word left outside the window simply does not get its turn: `wordSpans` gives
 * it no span, so it is neither highlighted in the preview nor written into the
 * export, and it comes back the moment the edge does.
 */
export function trimCue(cue: CaptionCue, edge: 'start' | 'end', value: number): CaptionCue {
  const start =
    edge === 'start' ? clamp(value, 0, Math.max(0, cue.end - MIN_CUE_DURATION)) : cue.start
  const end = edge === 'end' ? Math.max(value, start + MIN_CUE_DURATION) : cue.end
  return { ...cue, start, end }
}

/**
 * Rewrites a cue from edited text.
 *
 * This is what makes the transcript editable rather than merely readable, and
 * the whole difficulty is keeping the timings that were right. Words are matched
 * to the old ones by position, so fixing a misheard word — the overwhelmingly
 * common edit — keeps every timing in the line exactly as it was. Words with no
 * counterpart (a line that grew, or a rewrite past the end) are spread evenly
 * across whatever time is left after the ones that were kept.
 *
 * Returns null when the text is empty, which the caller reads as "delete this
 * cue" rather than leaving a caption on screen with nothing in it.
 */
export function setCueText(
  cue: CaptionCue,
  text: string,
  makeId: (prefix: string) => string,
): CaptionCue | null {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const kept = tokens.map((token, index) => {
    const existing = cue.words[index]
    return existing ? { ...existing, text: token } : null
  })

  // Anything past the end of the old line has no timing of its own. Give the
  // new tail an equal share of the time after the last word we did keep.
  const lastKept = [...kept].reverse().find(Boolean) ?? null
  const tailStart = lastKept ? lastKept.end : cue.start
  const tailCount = kept.filter((word) => word === null).length
  const tailSpan = Math.max(MIN_WORD_DURATION * tailCount, cue.end - tailStart)
  const tailStep = tailCount > 0 ? tailSpan / tailCount : 0

  let added = 0
  const words = kept.map((word, index) => {
    if (word) return word
    const start = tailStart + tailStep * added
    added += 1
    return {
      id: makeId('word'),
      text: tokens[index] ?? '',
      start,
      end: start + Math.max(MIN_WORD_DURATION, tailStep),
    }
  })

  return withBounds(cue, normalizeWords(words))
}

/**
 * Where a split at `index` would land, or null if it cannot land anywhere.
 *
 * Refused for the first word, for an index past the end, and — like a cut on the
 * picture track — where either half would come out shorter than a caption can
 * usefully be. Two words a twentieth of a second apart cannot be shown as two
 * captions, and forcing both halves up to the minimum would leave them
 * overlapping each other.
 */
export function splitBoundary(cue: CaptionCue, index: number): number | null {
  if (index <= 0 || index >= cue.words.length) return null
  const boundary = cue.words[index]?.start ?? cue.end
  if (boundary - cue.start < MIN_CUE_DURATION) return null
  if (cue.end - boundary < MIN_CUE_DURATION) return null
  return boundary
}

/**
 * Splits a cue in two before the word at `index`.
 *
 * The break lands on the word's own start, so neither half holds a word it does
 * not show, and the two halves between them cover exactly what the one cue
 * covered — a split changes where the line breaks, not how long there is
 * something on screen. Returns null where `splitBoundary` refuses, so a stray
 * click is a no-op rather than an edit.
 */
export function splitCue(
  cue: CaptionCue,
  index: number,
  makeId: (prefix: string) => string,
): [CaptionCue, CaptionCue] | null {
  const boundary = splitBoundary(cue, index)
  if (boundary === null) return null

  return [
    { ...cue, end: boundary, words: cue.words.slice(0, index) },
    {
      id: makeId('cue'),
      trackId: cue.trackId,
      start: boundary,
      end: cue.end,
      words: cue.words.slice(index),
      // Both halves were heard in the same clip, so splitting a line does not
      // lose track of where it came from.
      ...(cue.source ? { source: cue.source } : {}),
    },
  ]
}

/**
 * Joins a cue onto the one before it. The merged cue keeps the earlier one's id,
 * so whatever was selected stays selected.
 */
export function mergeCues(first: CaptionCue, second: CaptionCue): CaptionCue {
  return {
    ...first,
    start: Math.min(first.start, second.start),
    end: Math.max(first.end, second.end),
    words: normalizeWords([...first.words, ...second.words]),
  }
}

/**
 * Spreads a cue's words evenly across its span.
 *
 * The repair for a line whose timings are past saving — usually one that has
 * been rewritten wholesale. Even spacing is wrong in detail and right in
 * aggregate, which beats every word landing on the first frame.
 *
 * Strictly inside the cue, with no minimum word length: cramming eight words
 * into a short caption gives eight very brief highlights, which is what was
 * asked for, whereas letting them run past the end would leave the last of them
 * with no turn at all.
 */
export function spreadWordsEvenly(cue: CaptionCue): CaptionCue {
  const count = cue.words.length
  const span = Math.max(0, cue.end - cue.start)
  if (count === 0 || span <= 0) return cue
  const step = span / count
  return {
    ...cue,
    words: cue.words.map((word, index) => ({
      ...word,
      start: cue.start + step * index,
      end: cue.start + step * (index + 1),
    })),
  }
}

/**
 * Pulls a cue's bounds back inside the room it has on its track.
 *
 * Every edit funnels through this, because "one caption on screen at a time" is
 * the invariant the whole feature rests on and it has more than one way to be
 * broken: a move can be refused with a red outline, but a line that grew because
 * three words were typed into it cannot be — you do not refuse someone's typing.
 * So a growing cue stops where its neighbour starts, and words left outside the
 * window are handled the same way `trimCue` leaves them: silently without a turn,
 * until there is room again.
 *
 * Neighbours are found by the cue's own position on the track, so the cue passed
 * in must already be on it.
 */
export function fitBetweenNeighbours(cue: CaptionCue, cues: readonly CaptionCue[]): CaptionCue {
  const onTrack = cuesOnTrack(
    cues.filter((entry) => entry.id !== cue.id),
    cue.trackId,
  )
  const previous = onTrack.filter((entry) => entry.start < cue.start).at(-1)
  const next = onTrack.find((entry) => entry.start >= cue.start)

  const start = Math.max(0, previous ? Math.max(cue.start, previous.end) : cue.start)
  const end = Math.max(start, next ? Math.min(cue.end, next.start) : cue.end)
  if (start === cue.start && end === cue.end) return cue
  return { ...cue, start, end }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}
