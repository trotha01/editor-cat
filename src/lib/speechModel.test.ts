import { describe, expect, it } from 'vitest'
import { describeAttempt, labelAttempt, loadFailureMessage, verdictFor } from './speechModel'
import { SPEECH_MODEL_ATTEMPTS } from './models'

/**
 * The error a Whisper export really produced, reported from the field, verbatim.
 *
 * `qdq_actions.cc` is a graph *optimisation* — the model had downloaded intact,
 * and every export of it failed here identically, quantised and full-precision
 * alike, which is what says the optimiser is the problem rather than the weights.
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

  it('gives up when the model has no word timings, which no export would fix', () => {
    expect(
      verdictFor('Model generation config has no `alignment_heads`, token-level timestamps…'),
    ).toBe('give-up')
  })

  it('treats an unrecognised failure as worth trying the next weights', () => {
    // The ladder ends somewhere that cannot fail for a format reason, so an
    // unknown error costs one more attempt rather than the whole feature.
    expect(verdictFor('something nobody has seen before')).toBe('try-next')
  })
})

describe('the ladder itself', () => {
  it('turns the optimiser down before it reaches for a bigger file', () => {
    // The failure is in a graph optimisation, so the cheap fix is to ask for
    // less of it — and that reuses the download the first rung already made.
    const [first, second] = SPEECH_MODEL_ATTEMPTS
    expect(first?.graphOptimizationLevel).toBeUndefined()
    expect(second?.dtype).toBe(first?.dtype)
    expect(second?.graphOptimizationLevel).toBe('basic')
  })

  it('only fetches something else as a last resort', () => {
    const bigger = SPEECH_MODEL_ATTEMPTS.findIndex((attempt) => attempt.dtype === 'fp32')
    expect(bigger).toBe(SPEECH_MODEL_ATTEMPTS.length - 1)
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

  it('mentions the optimiser only when it is not the default', () => {
    expect(describeAttempt({ dtype: 'q8' })).not.toMatch(/optimisation/)
    expect(describeAttempt({ dtype: 'q8', graphOptimizationLevel: 'basic' })).toMatch(
      /fewer graph optimisations/,
    )
    expect(describeAttempt({ dtype: 'q8', graphOptimizationLevel: 'disabled' })).toMatch(
      /no graph optimisations/,
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
    const message = loadFailureMessage('onnx-community/whisper-base_timestamped', [
      `q8 — ${SESSION_REFUSED}`,
      `q8/basic — ${SESSION_REFUSED}`,
      `fp32/disabled — ${SESSION_REFUSED}`,
    ])
    expect(message).toContain('onnx-community/whisper-base_timestamped')
    expect(message).toContain('would not run in this browser')
    expect(message).toContain('3 ways')
    // Where to point the blame, and a way out that needs no code change.
    expect(message).toContain('points at the model')
    expect(message).toMatch(/Settings/)
  })

  it('says it is the connection when that is what it was', () => {
    const message = loadFailureMessage('some/model', ['q8 — Failed to fetch'])
    expect(message).toContain('huggingface.co')
    expect(message).not.toContain('would not run')
  })

  it('says what is actually wrong with a model that has no word timings', () => {
    const message = loadFailureMessage('some/model', [
      'q8 — Model generation config has no `alignment_heads`',
    ])
    expect(message).toContain('no word-level timing')
    expect(message).toContain('_timestamped')
  })
})
