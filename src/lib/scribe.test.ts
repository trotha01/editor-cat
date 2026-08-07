import { describe, expect, it } from 'vitest'
import { scribeInput, wordsFromScribe, type ScribeOutput } from './scribe'
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
