import { describe, expect, it } from 'vitest'
import { scribeInput, wordsFromScribe, type ScribeOutput } from './scribe'
import { cuesFromWords, wordsOntoTimeline } from './captions'
import { SPEECH_TO_TEXT_MODEL } from './models'

/**
 * A real Scribe v2 response, trimmed to the first few entries.
 *
 * Kept verbatim rather than hand-written, because the shape is the whole point:
 * the list interleaves words with the spacing between them, and a reader who
 * assumes `words` means words puts a caption on screen for every gap.
 */
const RESPONSE: ScribeOutput = {
  text: 'Hey, this is a test recording',
  words: [
    { end: 0.539, text: 'Hey,', type: 'word', start: 0.079, speaker_id: 'speaker_0' },
    { end: 0.599, text: ' ', type: 'spacing', start: 0.539, speaker_id: 'speaker_0' },
    { end: 0.679, text: 'this', type: 'word', start: 0.599, speaker_id: 'speaker_0' },
    { end: 0.739, text: ' ', type: 'spacing', start: 0.679, speaker_id: 'speaker_0' },
    { end: 0.799, text: 'is', type: 'word', start: 0.739, speaker_id: 'speaker_0' },
    { end: 0.939, text: ' ', type: 'spacing', start: 0.799, speaker_id: 'speaker_0' },
    { end: 0.939, text: 'a', type: 'word', start: 0.939, speaker_id: 'speaker_0' },
    { end: 0.959, text: ' ', type: 'spacing', start: 0.939, speaker_id: 'speaker_0' },
    { end: 1.179, text: 'test', type: 'word', start: 0.959, speaker_id: 'speaker_0' },
    { end: 1.219, text: ' ', type: 'spacing', start: 1.179, speaker_id: 'speaker_0' },
    { end: 1.719, text: 'recording', type: 'word', start: 1.22, speaker_id: 'speaker_0' },
  ],
  language_code: 'eng',
  language_probability: 1,
}

describe('wordsFromScribe', () => {
  it('takes the words and leaves the spacing between them', () => {
    const words = wordsFromScribe(RESPONSE)
    expect(words.map((word) => word.text)).toEqual(['Hey,', 'this', 'is', 'a', 'test', 'recording'])
  })

  it('keeps the timings exactly as given, since they are what the highlight follows', () => {
    const [first] = wordsFromScribe(RESPONSE)
    expect(first).toEqual({ text: 'Hey,', start: 0.079, end: 0.539 })
  })

  it('keeps punctuation, which is part of what was said and where a line ends', () => {
    expect(wordsFromScribe(RESPONSE)[0]?.text).toBe('Hey,')
  })

  it('keeps a word Scribe timed as instantaneous', () => {
    // "a" comes back with start === end. It was still said, and how long a word
    // stays lit is the caption model's decision, not this function's.
    const [instant] = wordsFromScribe({
      words: [{ text: 'a', start: 0.939, end: 0.939, type: 'word' }],
    })
    expect(instant).toEqual({ text: 'a', start: 0.939, end: 0.939 })
  })

  it('drops audio events, which are description rather than speech', () => {
    const words = wordsFromScribe({
      words: [
        { text: '(laughter)', start: 0, end: 1, type: 'audio_event' },
        { text: 'right', start: 1, end: 1.4, type: 'word' },
      ],
    })
    expect(words.map((word) => word.text)).toEqual(['right'])
  })

  it('drops a word with no timing rather than pinning it to zero', () => {
    // A word with no time cannot be highlighted at the right moment, and one
    // silently placed at the start of the clip is worse than one that is missing.
    const words = wordsFromScribe({
      words: [
        { text: 'untimed', type: 'word' },
        { text: 'timed', start: 1, end: 1.5, type: 'word' },
      ],
    })
    expect(words.map((word) => word.text)).toEqual(['timed'])
  })

  it('treats an entry with no type at all as a word', () => {
    // Defensive: `type` is documented, but a transcript silently emptied because
    // a field went missing would look exactly like silence.
    const words = wordsFromScribe({ words: [{ text: 'hello', start: 0, end: 0.5 }] })
    expect(words).toHaveLength(1)
  })

  it('says nothing rather than throwing when there are no words at all', () => {
    expect(wordsFromScribe({})).toEqual([])
    expect(wordsFromScribe({ words: [] })).toEqual([])
  })
})

describe('scribeInput', () => {
  it('turns off the two things that are on by default and thrown away', () => {
    // Both default to true at fal. Audio events are description rather than
    // speech and are filtered out on the way back in; a speaker label has
    // nowhere to go in a karaoke line. Asking for either is paying for work
    // this app then discards.
    const input = scribeInput('data:audio/wav;base64,AAAA')
    expect(input.tag_audio_events).toBe(false)
    expect(input.diarize).toBe(false)
  })

  it('does not ask for keyterms, which carry a 30% premium', () => {
    // Absent rather than sent empty: biasing the model towards a word list is a
    // feature to add knowingly, not to leave switched on by accident.
    expect(scribeInput('data:audio/wav;base64,AAAA')).not.toHaveProperty('keyterms')
  })

  it('sends the audio wherever the schema asks for a URL', () => {
    expect(scribeInput('data:audio/wav;base64,AAAA').audio_url).toBe('data:audio/wav;base64,AAAA')
  })

  it('names the language only when one was chosen', () => {
    // Absent means detect, which is right nearly always. Sending an empty
    // string instead would be asking Scribe to transcribe as nothing.
    expect(scribeInput('data:audio/wav;base64,AAAA', 'spa').language_code).toBe('spa')
    expect(scribeInput('data:audio/wav;base64,AAAA')).not.toHaveProperty('language_code')
    expect(scribeInput('data:audio/wav;base64,AAAA', '')).not.toHaveProperty('language_code')
  })
})

describe('the model behind captions', () => {
  it('is the one that times every word', () => {
    // The whole reason captions are worth doing at all: a transcript with only
    // sentence timings would have its word timings guessed, and guessed word
    // timings are what a highlight moving across the line makes obvious.
    expect(SPEECH_TO_TEXT_MODEL).toBe('fal-ai/elevenlabs/speech-to-text/scribe-v2')
  })
})

/**
 * The whole path, on a real response, with the arithmetic that puts words on
 * the timeline.
 *
 * Worth having end to end rather than as three separate unit tests: every step
 * here is individually correct and the interesting failures are at the joins —
 * a chunk offset added twice, a lead-in forgotten, a source's in-point applied
 * to the wrong clock. A caption that lands at the wrong second is the one bug
 * the tests either side of this would both pass.
 */
describe('from a Scribe response to captions on the timeline', () => {
  // Reported from a real run: narration over a generated clip, part Latin and
  // part English, which is also why Scribe called the whole thing Latin.
  const LION: ScribeOutput = {
    text: 'Haec tabellubia leo roseus mirabilis est. This cutie is an amazing pink lion',
    language_code: 'lat',
    language_probability: 0.5581640005111694,
    words: [
      { text: 'Haec', start: 1.039, end: 1.24, type: 'word' },
      { text: ' ', start: 1.24, end: 1.259, type: 'spacing' },
      { text: 'tabellubia', start: 1.259, end: 2.079, type: 'word' },
      { text: ' ', start: 2.079, end: 2.119, type: 'spacing' },
      { text: 'leo', start: 2.119, end: 2.44, type: 'word' },
      { text: ' ', start: 2.44, end: 2.5, type: 'spacing' },
      { text: 'roseus', start: 2.5, end: 3.179, type: 'word' },
      { text: ' ', start: 3.179, end: 3.199, type: 'spacing' },
      { text: 'mirabilis', start: 3.199, end: 4.299, type: 'word' },
      { text: ' ', start: 4.299, end: 4.419, type: 'spacing' },
      { text: 'est.', start: 4.42, end: 4.779, type: 'word' },
      { text: ' ', start: 4.779, end: 5.739, type: 'spacing' },
      { text: 'This', start: 5.739, end: 6.019, type: 'word' },
      { text: ' ', start: 6.019, end: 6.059, type: 'spacing' },
      { text: 'cutie', start: 6.059, end: 6.42, type: 'word' },
      { text: ' ', start: 6.42, end: 6.46, type: 'spacing' },
      { text: 'is', start: 6.46, end: 6.559, type: 'word' },
      { text: ' ', start: 6.559, end: 6.579, type: 'spacing' },
      { text: 'an', start: 6.579, end: 6.639, type: 'word' },
      { text: ' ', start: 6.639, end: 6.799, type: 'spacing' },
      { text: 'amazing', start: 6.799, end: 7.299, type: 'word' },
      { text: ' ', start: 7.299, end: 7.319, type: 'spacing' },
      { text: 'pink', start: 7.319, end: 7.519, type: 'word' },
      { text: ' ', start: 7.519, end: 7.619, type: 'spacing' },
      { text: 'lion', start: 7.619, end: 7.999, type: 'word' },
    ],
  }

  const clip = { id: 'clip-7', label: 'lion.mp4', startTime: 2, inPoint: 0, duration: 9 }
  let n = 0
  const makeId = (prefix: string) => `${prefix}-${++n}`

  it('puts every word on the timeline, shifted by where its clip sits', () => {
    const onTimeline = wordsOntoTimeline(wordsFromScribe(LION), clip)

    expect(onTimeline).toHaveLength(13)
    // The clip opens two seconds in, so the first word is heard two seconds
    // later than Scribe — which timed it against the audio, not the timeline.
    expect(onTimeline[0]?.start).toBeCloseTo(3.039, 6)
    expect(onTimeline.at(-1)?.end).toBeCloseTo(9.999, 6)
    expect(onTimeline.every((word) => Number.isFinite(word.start))).toBe(true)
  })

  it('groups them into captions that a lane can actually draw', () => {
    // The symptom a caption with a broken time shows on the timeline is nothing
    // at all: an absolutely positioned block at NaN pixels simply is not there,
    // while the same cue still reads fine in the transcript.
    const cues = cuesFromWords(wordsOntoTimeline(wordsFromScribe(LION), clip), 'track-1', makeId)

    expect(cues.length).toBeGreaterThan(0)
    for (const cue of cues) {
      expect(Number.isFinite(cue.start)).toBe(true)
      expect(cue.end).toBeGreaterThan(cue.start)
      expect(cue.trackId).toBe('track-1')
      expect(cue.words.length).toBeGreaterThan(0)
    }
    // Sentence-final punctuation and the one-second pause after "est." both end
    // a caption, so the Latin and the English do not share a line.
    expect(cues.length).toBeGreaterThan(1)
  })

  it('records which clip each caption was heard in', () => {
    const cues = cuesFromWords(wordsOntoTimeline(wordsFromScribe(LION), clip), 'track-1', makeId)
    for (const cue of cues) {
      expect(cue.source).toEqual({ id: 'clip-7', label: 'lion.mp4' })
    }
  })

  it('says nothing about a source when the words came from nowhere in particular', () => {
    // Hand-made cues and every project captioned before this existed.
    const cues = cuesFromWords([{ text: 'typed', start: 0, end: 1 }], 'track-1', makeId)
    expect(cues[0]).not.toHaveProperty('source')
  })
})
