import { describe, expect, it } from 'vitest'
import {
  MIN_WORD_DURATION,
  activeWordIndexAt,
  captionsEnd,
  cueAtTime,
  cueText,
  cuesFromWords,
  cuesOnTrack,
  dedupeOverlappingWords,
  fitBetweenNeighbours,
  defaultCaptionStyle,
  mergeCues,
  moveCue,
  recaptionSource,
  setCueText,
  setWordTiming,
  splitBoundary,
  splitCue,
  spreadWordsEvenly,
  trimCue,
  wordSpans,
  wordsOntoTimeline,
  type TimedWord,
} from './captions'
import type { CaptionCue, CaptionWord } from './types'

let counter = 0
const makeId = (prefix: string) => `${prefix}-${(counter += 1)}`

const word = (text: string, start: number, end: number): CaptionWord => ({
  id: `w-${text}-${start}`,
  text,
  start,
  end,
})

const cue = (words: CaptionWord[], start?: number, end?: number): CaptionCue => ({
  id: 'cue-1',
  trackId: 'track-1',
  start: start ?? words[0]?.start ?? 0,
  end: end ?? words[words.length - 1]?.end ?? 1,
  words,
})

const timed = (text: string, start: number, end: number): TimedWord => ({ text, start, end })

describe('cuesFromWords', () => {
  it('groups a run of words into captions of a readable length', () => {
    const words = Array.from({ length: 9 }, (_, index) =>
      timed(`w${index}`, index * 0.3, index * 0.3 + 0.25),
    )
    const cues = cuesFromWords(words, 'track-1', makeId)

    expect(cues).toHaveLength(3)
    expect(cues.every((entry) => entry.words.length <= 4)).toBe(true)
    expect(cues.flatMap((entry) => entry.words).map((entry) => entry.text)).toEqual(
      words.map((entry) => entry.text),
    )
  })

  it('breaks a caption at the end of a sentence, however few words are on screen', () => {
    const cues = cuesFromWords(
      [timed('Right.', 0, 0.4), timed('Next', 0.5, 0.8), timed('thing', 0.8, 1.1)],
      'track-1',
      makeId,
    )
    expect(cues.map(cueText)).toEqual(['Right.', 'Next thing'])
  })

  it('breaks on a pause long enough to be one, and leaves the screen clear for it', () => {
    const cues = cuesFromWords([timed('one', 0, 0.3), timed('two', 4, 4.3)], 'track-1', makeId, {
      maxWords: 8,
      maxGap: 0.6,
      maxSeconds: 60,
      holdThroughGap: 0.7,
    })
    expect(cues).toHaveLength(2)
    expect(cues[0]?.end).toBeLessThan(cues[1]!.start)
  })

  it('never overlaps two captions, whatever the transcriber said', () => {
    // Words that run together across a sentence break, which a transcriber does
    // emit — and which would otherwise leave two captions on screen at once.
    const cues = cuesFromWords(
      [timed('Hello.', 0, 0.5), timed('there', 0.45, 0.9), timed('friend', 0.95, 1.4)],
      'track-1',
      makeId,
    )
    expect(cues).toHaveLength(2)
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start)
  })

  it('leaves no overlap when a one-word caption is padded to the minimum length', () => {
    // "Right." is a caption of its own and shorter than MIN_CUE_DURATION, so it
    // gets padded — straight into the caption after it, without this.
    const cues = cuesFromWords(
      [timed('Right.', 0, 0.05), timed('Next', 0.08, 0.4)],
      'track-1',
      makeId,
    )
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start)
  })

  it('holds a caption through the breath before the next one, so it does not blink', () => {
    // Five words at a steady pace: the fourth starts a new caption, a tenth of
    // a second after the third ends.
    const words = Array.from({ length: 5 }, (_, index) =>
      timed(`w${index}`, index * 0.4, index * 0.4 + 0.3),
    )
    const cues = cuesFromWords(words, 'track-1', makeId)
    expect(cues).toHaveLength(2)
    expect(cues[0]?.end).toBe(cues[1]?.start)
  })

  it('gives a zero-length word something to be highlighted for', () => {
    const [only] = cuesFromWords([timed('hm', 1, 1)], 'track-1', makeId)
    expect(only?.words[0]?.end).toBeGreaterThan(1)
  })

  it('skips blank words rather than captioning them', () => {
    const cues = cuesFromWords([timed('  ', 0, 0.2), timed('real', 0.3, 0.6)], 'track-1', makeId)
    expect(cues.flatMap((entry) => entry.words).map((entry) => entry.text)).toEqual(['real'])
  })
})

describe('dedupeOverlappingWords', () => {
  it('keeps a straight run of speech intact', () => {
    const words = [timed('one', 0, 0.4), timed('two', 0.4, 0.8), timed('three', 0.8, 1.2)]
    expect(dedupeOverlappingWords(words)).toEqual(words)
  })

  it('drops the second transcription of a line recorded twice', () => {
    // Two takes of the same words, both on the timeline at the same moment.
    const doubled = [
      timed('This', 0, 0.4),
      timed('This', 0.01, 0.41),
      timed('is', 0.4, 0.8),
      timed('is', 0.41, 0.81),
    ]
    expect(dedupeOverlappingWords(doubled).map((entry) => entry.text)).toEqual(['This', 'is'])
  })

  it('tolerates the slight overlap running speech really has', () => {
    const words = [timed('run', 0, 0.4), timed('on', 0.35, 0.75)]
    expect(dedupeOverlappingWords(words)).toHaveLength(2)
  })
})

describe('wordsOntoTimeline', () => {
  it('moves file times onto the timeline through the clip that plays them', () => {
    const words = wordsOntoTimeline([timed('hello', 1, 1.5)], {
      startTime: 10,
      inPoint: 1,
      duration: 5,
    })
    // The word is at the very start of what the clip uses, so it lands on the
    // clip's own start.
    expect(words).toEqual([{ text: 'hello', start: 10, end: 10.5 }])
  })

  it('drops words the clip was trimmed past', () => {
    const words = wordsOntoTimeline(
      [timed('before', 0, 0.5), timed('inside', 2, 2.5), timed('after', 9, 9.5)],
      { startTime: 0, inPoint: 1, duration: 3 },
    )
    expect(words.map((entry) => entry.text)).toEqual(['inside'])
  })

  it('holds a word straddling the edit only for as long as it is audible', () => {
    const [held] = wordsOntoTimeline([timed('long', 0.5, 2)], {
      startTime: 0,
      inPoint: 1,
      duration: 3,
    })
    expect(held).toEqual({ text: 'long', start: 0, end: 1 })
  })
})

describe('recaptionSource', () => {
  /** A word heard in a particular clip, which is what makes it swappable. */
  const heard = (clipId: string, text: string, start: number, end: number): TimedWord => ({
    text,
    start,
    end,
    source: { id: clipId, label: `${clipId}.webm` },
  })

  /** Two clips, a second apart so their words never group into one caption. */
  const twoClips = () =>
    cuesFromWords(
      [
        heard('clip-a', 'first', 0, 0.4),
        heard('clip-a', 'take.', 0.5, 0.9),
        heard('clip-b', 'second', 3, 3.4),
        heard('clip-b', 'take.', 3.5, 3.9),
      ],
      'track-1',
      makeId,
    )

  it('replaces one clip’s captions and leaves the others untouched', () => {
    const before = twoClips()
    const kept = before.filter((entry) => entry.source?.id === 'clip-b')

    const result = recaptionSource(
      before,
      'track-1',
      'clip-a',
      [heard('clip-a', 'better', 0, 0.4), heard('clip-a', 'take.', 0.5, 0.9)],
      makeId,
    )

    expect(result.cues.filter((entry) => entry.source?.id === 'clip-a').map(cueText)).toEqual([
      'better take.',
    ])
    // By identity, not by contents: the whole point is that a correction made to
    // another clip's line — a retyped word, a dragged edge — cannot be disturbed
    // by a redo aimed somewhere else.
    expect(result.cues.filter((entry) => entry.source?.id === 'clip-b')).toEqual(kept)
    expect(result.replaced).toBe(1)
    expect(result.fresh).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it('leaves a caption that claims no clip alone, since nothing says it is stale', () => {
    const typed: CaptionCue = { ...cue([word('typed', 5, 5.4)]), id: 'typed-by-hand' }
    const result = recaptionSource(
      [...twoClips(), typed],
      'track-1',
      'clip-a',
      [heard('clip-a', 'again.', 0, 0.4)],
      makeId,
    )

    expect(result.cues).toContain(typed)
  })

  it('leaves another track’s captions alone, whichever clip they came from', () => {
    const elsewhere: CaptionCue = {
      ...cue([word('translated', 0, 0.4)]),
      id: 'other-track',
      trackId: 'track-2',
      source: { id: 'clip-a', label: 'clip-a.webm' },
    }
    const result = recaptionSource(
      [...twoClips(), elsewhere],
      'track-1',
      'clip-a',
      [heard('clip-a', 'again.', 0, 0.4)],
      makeId,
    )

    expect(result.cues).toContain(elsewhere)
    expect(result.replaced).toBe(1)
  })

  it('removes a clip’s captions when it comes back with nothing to say', () => {
    const result = recaptionSource(twoClips(), 'track-1', 'clip-a', [], makeId)

    expect(result.cues.map(cueText)).toEqual(['second take.'])
    expect(result.replaced).toBe(1)
    expect(result.fresh).toEqual([])
  })

  it('pulls a new caption back to where the ones that stayed leave room', () => {
    // The clip has been retimed since it was last transcribed, so its words now
    // run into a caption from the clip after it. The one that stayed wins.
    const result = recaptionSource(
      twoClips(),
      'track-1',
      'clip-a',
      [heard('clip-a', 'runs', 2.5, 2.9), heard('clip-a', 'long.', 3.4, 3.8)],
      makeId,
    )

    const moved = result.fresh[0]!
    expect(moved.end).toBeCloseTo(3)
    expect(result.cues.filter((entry) => entry.source?.id === 'clip-b').map(cueText)).toEqual([
      'second take.',
    ])
    expect(result.dropped).toBe(0)
  })

  it('drops a new caption with no room rather than covering another clip’s', () => {
    const result = recaptionSource(
      twoClips(),
      'track-1',
      'clip-a',
      // Squarely under clip-b's caption, which is not going anywhere.
      [heard('clip-a', 'underneath.', 3.1, 3.5)],
      makeId,
    )

    expect(result.fresh).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.cues.map(cueText)).toEqual(['second take.'])
  })

  it('never leaves two captions on screen at once', () => {
    const result = recaptionSource(
      twoClips(),
      'track-1',
      'clip-a',
      Array.from({ length: 12 }, (_, index) =>
        heard('clip-a', `w${index}`, index * 0.35, index * 0.35 + 0.3),
      ),
      makeId,
    )

    const ordered = cuesOnTrack(result.cues, 'track-1')
    for (const [index, entry] of ordered.entries()) {
      const next = ordered[index + 1]
      if (next) expect(entry.end).toBeLessThanOrEqual(next.start + 1e-6)
    }
    expect(result.fresh.length).toBeGreaterThan(0)
  })
})

describe('wordSpans and activeWordIndexAt agree about which word is lit', () => {
  const line = cue([word('a', 0, 0.2), word('b', 1, 1.2), word('c', 2, 2.2)], 0, 3)

  it('tiles the cue with no gaps, so the highlight never blinks out mid-line', () => {
    const spans = wordSpans(line)
    expect(spans.map((span) => [span.start, span.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ])
  })

  it('keeps a word lit through the pause after it', () => {
    expect(activeWordIndexAt(line, 0.5)).toBe(0)
    expect(activeWordIndexAt(line, 1.5)).toBe(1)
    expect(activeWordIndexAt(line, 2.9)).toBe(2)
  })

  it('lights nothing before the first word or after the cue', () => {
    const late = cue([word('a', 1, 1.2)], 0, 2)
    expect(activeWordIndexAt(late, 0.5)).toBe(-1)
    expect(activeWordIndexAt(late, 3)).toBe(-1)
  })

  it('picks the cue on screen, and nothing between cues', () => {
    const cues = [cue([word('a', 0, 1)], 0, 1), { ...cue([word('b', 2, 3)], 2, 3), id: 'cue-2' }]
    expect(cueAtTime(cues, 0.5)?.id).toBe('cue-1')
    expect(cueAtTime(cues, 1.5)).toBeNull()
    expect(cueAtTime(cues, 2.5)?.id).toBe('cue-2')
    // Half-open, so the boundary belongs to exactly one cue.
    expect(cueAtTime(cues, 1)).toBeNull()
  })
})

describe('setCueText', () => {
  const line = cue([word('the', 0, 0.3), word('kat', 0.4, 0.7), word('sat', 0.8, 1.1)], 0, 1.5)

  it('keeps every timing when a word is corrected', () => {
    const fixed = setCueText(line, 'the cat sat', makeId)
    expect(fixed?.words.map((entry) => [entry.text, entry.start, entry.end])).toEqual([
      ['the', 0, 0.3],
      ['cat', 0.4, 0.7],
      ['sat', 0.8, 1.1],
    ])
    // The ids survive too, so a selected word stays selected through an edit.
    expect(fixed?.words[1]?.id).toBe(line.words[1]?.id)
  })

  it('spreads words added to the end across the time left in the cue', () => {
    const grown = setCueText(line, 'the cat sat down again', makeId)
    expect(grown?.words).toHaveLength(5)
    const added = grown?.words.slice(3) ?? []
    expect(added.map((entry) => entry.text)).toEqual(['down', 'again'])
    expect(added[0]?.start).toBeCloseTo(1.1)
    expect(added[1]?.start).toBeGreaterThan(added[0]?.start ?? 0)
  })

  it('drops words removed from the end', () => {
    expect(setCueText(line, 'the cat', makeId)?.words.map((entry) => entry.text)).toEqual([
      'the',
      'cat',
    ])
  })

  it('reports an emptied line as no caption at all', () => {
    expect(setCueText(line, '   ', makeId)).toBeNull()
  })
})

describe('setWordTiming', () => {
  const line = cue([word('a', 0, 0.3), word('b', 1, 1.3), word('c', 2, 2.3)], 0, 3)

  it('retimes a word', () => {
    const moved = setWordTiming(line, line.words[1]!.id, { start: 1.4 })
    expect(moved.words[1]?.start).toBeCloseTo(1.4)
  })

  it('refuses to let a word overtake its neighbours', () => {
    const past = setWordTiming(line, line.words[1]!.id, { start: 5 })
    expect(past.words[1]!.start).toBeLessThan(past.words[2]!.start)

    const before = setWordTiming(line, line.words[1]!.id, { start: -5 })
    expect(before.words[1]!.start).toBeGreaterThan(before.words[0]!.start)
  })

  it('never lets a word end before it starts', () => {
    const squashed = setWordTiming(line, line.words[0]!.id, { end: -1 })
    expect(squashed.words[0]!.end).toBeGreaterThanOrEqual(
      squashed.words[0]!.start + MIN_WORD_DURATION,
    )
  })
})

describe('moving and trimming a caption', () => {
  const line = cue([word('a', 1, 1.3), word('b', 2, 2.3)], 1, 3)

  it('takes the words along, keeping their spacing', () => {
    const moved = moveCue(line, 5)
    expect(moved.start).toBe(5)
    expect(moved.end).toBe(7)
    expect(moved.words.map((entry) => entry.start)).toEqual([5, 6])
  })

  it('clamps at the start of the timeline', () => {
    expect(moveCue(line, -10).start).toBe(0)
  })

  it('leaves the words where they are when only the edge moves', () => {
    const held = trimCue(line, 'end', 6)
    expect(held.end).toBe(6)
    expect(held.words.map((entry) => entry.start)).toEqual([1, 2])
  })

  it('leaves a word outside the window without a turn, rather than moving it', () => {
    const shortened = trimCue(line, 'end', 1.5)
    expect(shortened.words.map((entry) => entry.start)).toEqual([1, 2])
    expect(wordSpans(shortened).map((span) => span.word.text)).toEqual(['a'])
  })

  it('is repeatable, so overshooting a drag and correcting it loses nothing', () => {
    // A drag applies this once per pointer event, to the cue as it already
    // stands. Anything that moved the words would compound across the gesture.
    const overshot = trimCue(line, 'start', 2.9)
    const corrected = trimCue(overshot, 'start', 1)
    expect(corrected).toEqual(trimCue(line, 'start', 1))
  })
})

describe('fitBetweenNeighbours', () => {
  const first = { ...cue([word('a', 0, 0.4)], 0, 1), id: 'first' }
  const second = { ...cue([word('b', 1, 1.4)], 1, 2), id: 'second' }

  it('leaves a caption with room alone', () => {
    expect(fitBetweenNeighbours(first, [first, second])).toBe(first)
  })

  it('stops a caption that grew from running into the next one', () => {
    const grown = { ...first, end: 1.6 }
    expect(fitBetweenNeighbours(grown, [first, second]).end).toBe(1)
  })

  it('stops one that grew backwards from running into the one before', () => {
    const grown = { ...second, start: 0.4 }
    expect(fitBetweenNeighbours(grown, [first, second]).start).toBe(1)
  })

  it('never lets a caption end before it starts', () => {
    const squeezed = { ...second, start: 0.4, end: 0.5 }
    const fitted = fitBetweenNeighbours(squeezed, [first, second])
    expect(fitted.end).toBeGreaterThanOrEqual(fitted.start)
  })

  it('ignores captions on other tracks, which have their own screen time', () => {
    const elsewhere = { ...second, id: 'other', trackId: 'track-2' }
    expect(fitBetweenNeighbours({ ...first, end: 1.6 }, [first, elsewhere]).end).toBe(1.6)
  })
})

describe('splitting and merging', () => {
  const line = cue([word('a', 0, 0.3), word('b', 1, 1.3), word('c', 2, 2.3)], 0, 3)

  it('splits before the chosen word, keeping every word exactly once', () => {
    const halves = splitCue(line, 1, makeId)
    expect(halves?.[0]?.words.map((entry) => entry.text)).toEqual(['a'])
    expect(halves?.[1]?.words.map((entry) => entry.text)).toEqual(['b', 'c'])
    expect(halves?.[0]?.end).toBeCloseTo(1)
    expect(halves?.[1]?.start).toBeCloseTo(1)
  })

  it('refuses a split that would leave an empty half', () => {
    expect(splitCue(line, 0, makeId)).toBeNull()
    expect(splitCue(line, 3, makeId)).toBeNull()
  })

  it('refuses a split that would leave a caption too short to read', () => {
    // Two words a heartbeat apart cannot become two captions, and forcing both
    // halves up to the minimum would leave them overlapping each other.
    const fast = cue([word('a', 0, 0.05), word('b', 0.06, 0.1), word('c', 1, 1.4)], 0, 2)
    expect(splitBoundary(fast, 1)).toBeNull()
    expect(splitCue(fast, 1, makeId)).toBeNull()
    // The later break has room on both sides, so it is still offered.
    expect(splitBoundary(fast, 2)).toBe(1)
  })

  it('leaves no gap and no overlap between the halves', () => {
    const [head, tail] = splitCue(line, 1, makeId)!
    expect(head.end).toBe(tail.start)
    expect(tail.end).toBe(line.end)
  })

  it('merges two captions back into one, keeping the first one’s id', () => {
    const [head, tail] = splitCue(line, 1, makeId)!
    const merged = mergeCues(head, tail)
    expect(merged.id).toBe(head.id)
    expect(cueText(merged)).toBe('a b c')
    expect(merged.start).toBe(0)
    expect(merged.end).toBe(3)
  })
})

describe('spreadWordsEvenly', () => {
  it('lays the words out across the caption, in order', () => {
    const respaced = spreadWordsEvenly(cue([word('a', 0, 0.1), word('b', 0, 0.1)], 0, 2))
    expect(respaced.words.map((entry) => entry.start)).toEqual([0, 1])
    expect(respaced.words.map((entry) => entry.end)).toEqual([1, 2])
  })

  it('keeps every word inside the caption, however many there are', () => {
    // Crammed in, because a word laid past the end would get no turn at all.
    const crowded = cue(
      Array.from({ length: 8 }, (_, index) => word(`w${index}`, 0, 0.05)),
      0,
      0.2,
    )
    const respaced = spreadWordsEvenly(crowded)
    expect(respaced.words.every((entry) => entry.start < respaced.end)).toBe(true)
    expect(wordSpans(respaced)).toHaveLength(8)
  })
})

describe('project-level helpers', () => {
  it('reports when the last caption leaves the screen', () => {
    expect(
      captionsEnd([cue([word('a', 0, 1)], 0, 1), { ...cue([]), id: 'b', start: 4, end: 9 }]),
    ).toBe(9)
    expect(captionsEnd([])).toBe(0)
  })

  it('returns a track’s captions in playing order', () => {
    const late = { ...cue([word('b', 5, 6)], 5, 6), id: 'late' }
    const early = { ...cue([word('a', 1, 2)], 1, 2), id: 'early' }
    const other = { ...cue([word('c', 0, 1)], 0, 1), id: 'other', trackId: 'track-2' }
    expect(cuesOnTrack([late, early, other], 'track-1').map((entry) => entry.id)).toEqual([
      'early',
      'late',
    ])
  })

  it('defaults to large and low in the frame, at the face’s own weight', () => {
    const style = defaultCaptionStyle()
    // Not bold: the shipped face has one weight, and asking for a second gets it
    // faked — by the browser in the preview and by libass in the export, which
    // are two different approximations of the same thing.
    expect(style.bold).toBe(false)
    expect(style.fontScale).toBeGreaterThan(0.05)
    expect(style.position).toBeGreaterThan(0.5)
  })
})
