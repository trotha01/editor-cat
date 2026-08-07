import { describe, expect, it } from 'vitest'
import {
  describeAttempt,
  isMissingAlignment,
  labelAttempt,
  loadFailureMessage,
  verdictFor,
} from './speechModel'
import { DEFAULT_SPEECH_MODEL, FALLBACK_SPEECH_MODEL, SPEECH_MODEL_ATTEMPTS } from './models'

/**
 * The error a Whisper export really produced, reported from the field, verbatim.
 *
 * It survived every export the repo publishes *and* every graph optimisation
 * level including none, which between them rule out both the weights and any
 * optional rewrite — leaving the model file itself, which no session option can
 * repair. That is why every rung of the ladder is now a different file, and why
 * the repo it came from is no longer the one tried first.
 */
const SESSION_REFUSED =
  "Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137 " +
  'TransposeDQWeightsForMatMulNBits Missing required scale: ' +
  'model.decoder.embed_tokens.weight_merged_0_scale for node: ' +
  'model.decoder.embed_tokens.weight_transposed_DequantizeLinear'

describe('verdictFor', () => {
  it('tries other weights when the runtime refuses to build a session', () => {
    // The whole reason the ladder exists: the file arrived and is unusable, and
    // a differently quantised export of the same model may not be.
    expect(verdictFor(SESSION_REFUSED)).toBe('try-next')
  })

  it('tries other weights when the repo does not publish these', () => {
    expect(verdictFor('Could not locate file: "…/decoder_model_merged_int8.onnx"')).toBe('try-next')
    expect(verdictFor('Unauthorized access to file: 404')).toBe('try-next')
  })

  it('gives up when the hub cannot be reached at all', () => {
    // Walking the ladder against a dead network just makes the same failure
    // three times over.
    expect(verdictFor('Failed to fetch')).toBe('give-up')
    expect(verdictFor('NetworkError when attempting to fetch resource.')).toBe('give-up')
    expect(verdictFor('Load failed')).toBe('give-up')
  })

  it('recognises the model that cannot time words, which is not a load failure', () => {
    // Recovered where it happens by asking the same model for phrase timings
    // instead, so it never reaches the ladder — but it has to be told apart from
    // a real failure first.
    const detail = 'Model generation config has no `alignment_heads`, token-level timestamps…'
    expect(isMissingAlignment(detail)).toBe(true)
    expect(isMissingAlignment(SESSION_REFUSED)).toBe(false)
  })

  it('treats an unrecognised failure as worth trying the next weights', () => {
    // The ladder ends somewhere that cannot fail for a format reason, so an
    // unknown error costs one more attempt rather than the whole feature.
    expect(verdictFor('something nobody has seen before')).toBe('try-next')
  })
})

describe('the ladder itself', () => {
  it('varies the file every rung, since nothing else can move that error', () => {
    // Session options were tried and ruled out: transformers.js passes them
    // through to ONNX Runtime untouched, the runtime reads them, and the failure
    // happened anyway with optimisation off entirely. So a rung that re-reads
    // the same download is a rung that cannot help.
    const files = SPEECH_MODEL_ATTEMPTS.map((attempt) => `${attempt.model ?? ''}|${attempt.dtype}`)
    expect(new Set(files).size).toBe(files.length)
  })

  it('reaches a model from another publisher, since one repo can be unusable', () => {
    const other = SPEECH_MODEL_ATTEMPTS.filter((attempt) => attempt.model)
    expect(other.length).toBeGreaterThan(0)
    expect(other.every((attempt) => attempt.model === FALLBACK_SPEECH_MODEL)).toBe(true)
    // And it is not the configured model under another name: the whole point is
    // a different conversion of the same weights.
    expect(FALLBACK_SPEECH_MODEL.split('/')[0]).not.toBe(DEFAULT_SPEECH_MODEL.split('/')[0])
  })

  it('leaves the biggest download until last', () => {
    const bigger = SPEECH_MODEL_ATTEMPTS.findIndex((attempt) => attempt.dtype === 'fp32')
    expect(bigger).toBe(SPEECH_MODEL_ATTEMPTS.length - 1)
  })

  it("tries the configured model before anyone else's", () => {
    expect(SPEECH_MODEL_ATTEMPTS[0]?.model).toBeUndefined()
  })

  it('never repeats a way of opening the model', () => {
    const labels = SPEECH_MODEL_ATTEMPTS.map(labelAttempt)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('describeAttempt', () => {
  it('warns that the last resort is a bigger download', () => {
    expect(describeAttempt({ dtype: 'fp32' })).toMatch(/larger download/)
  })

  it('names the model when it is not the one that was configured', () => {
    // The part that changes what the transcript says, rather than how long it
    // took to produce.
    expect(describeAttempt({ dtype: 'q8' })).not.toContain('/')
    expect(describeAttempt({ model: 'Xenova/whisper-base', dtype: 'q8' })).toContain(
      'Xenova/whisper-base',
    )
    expect(labelAttempt({ model: 'Xenova/whisper-base', dtype: 'q8' })).toContain(
      'Xenova/whisper-base',
    )
  })

  it('has something to say about every rung of the ladder', () => {
    for (const attempt of SPEECH_MODEL_ATTEMPTS) {
      expect(describeAttempt(attempt)).toBeTruthy()
      expect(labelAttempt(attempt)).toBeTruthy()
    }
  })
})

describe('loadFailureMessage', () => {
  it('names the model and every attempt when none of them ran', () => {
    const message = loadFailureMessage('Xenova/whisper-base', [
      `q8 — ${SESSION_REFUSED}`,
      `onnx-community/whisper-base_timestamped q8 — ${SESSION_REFUSED}`,
      `fp32 — ${SESSION_REFUSED}`,
    ])
    expect(message).toContain('Xenova/whisper-base')
    expect(message).toContain('3 ways')
    // By this point a second publisher has been tried, so the honest thing to
    // say is that something unusual is going on rather than to blame the repo.
    expect(message).toContain('different publisher')
    expect(message).toMatch(/Settings/)
  })

  it('says it is the connection when that is what it was', () => {
    const message = loadFailureMessage('some/model', ['q8 — Failed to fetch'])
    expect(message).toContain('huggingface.co')
    expect(message).not.toContain('would not run')
  })

  it('never blames word timings, which are no longer a reason to fail', () => {
    // A model that loads and cannot time words is captioned from anyway, so this
    // message is only ever about a model that would not load at all. Telling
    // someone to go and find a "_timestamped" repo would send them after a
    // requirement that no longer exists.
    const message = loadFailureMessage('some/model', [
      'q8 — Model generation config has no `alignment_heads`',
    ])
    expect(message).not.toContain('No word-level timing')
    expect(message).not.toContain('_timestamped')
  })
})
