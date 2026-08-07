import { describe, expect, it } from 'vitest'
import { describeWeights, loadFailureMessage, verdictFor } from './speechModel'
import { SPEECH_MODEL_DTYPES } from './models'

/**
 * The error a quantised Whisper export really produced, reported from the field.
 * `MatMulNBits` is the operator four-bit block quantisation compiles to, and the
 * model had already downloaded intact when this happened.
 */
const SESSION_REFUSED =
  "Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137 " +
  'TransposeDQWeightsForMatMulNBits Missing required scale: ' +
  'model.decoder.embed_tokens.weight_merged_0_scale for node:'

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

describe('describeWeights', () => {
  it('warns that the fallback is a bigger download', () => {
    expect(describeWeights('fp32')).toMatch(/larger download/)
  })

  it('has something to say about every rung of the ladder', () => {
    for (const dtype of SPEECH_MODEL_DTYPES) {
      expect(describeWeights(dtype)).toBeTruthy()
    }
  })
})

describe('loadFailureMessage', () => {
  it('names the model and every format tried when none of them ran', () => {
    const message = loadFailureMessage('onnx-community/whisper-base_timestamped', [
      `q8 — ${SESSION_REFUSED}`,
      'int8 — Could not locate file',
      `fp32 — ${SESSION_REFUSED}`,
    ])
    expect(message).toContain('onnx-community/whisper-base_timestamped')
    expect(message).toContain('would not run in this browser')
    expect(message).toContain('3 formats')
    // A way out that does not need a code change.
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
