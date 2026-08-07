/**
 * Reading what went wrong when a speech model will not load.
 *
 * Loading a model is three failures wearing one coat: the network could not
 * reach the hub, the hub does not have that file, or the file arrived and the
 * runtime refused to run it. They want opposite responses — give up, try the
 * next weights, try the next weights — and the underlying errors say none of
 * this. "Failed to fetch" is what a browser reports for being offline, for a
 * blocked network and for a repo that does not exist.
 *
 * So the strings are read here, in a module with nothing else in it, where the
 * reading can be tested against the errors really seen rather than against a
 * guess about them.
 */

/** What to do about a failed attempt to load one set of weights. */
export type LoadVerdict =
  /** These weights are no good, but another set might be. */
  | 'try-next'
  /** Nothing about the weights would help. Stop and say so. */
  | 'give-up'

/**
 * Errors that no other export can fix.
 *
 * A network that cannot reach the hub will not reach it for the next file
 * either, and walking a ladder against it just makes the same failure three
 * times over. Alignment heads are a property of the repo rather than of the
 * weights, so the answer there is a different model, not a different dtype.
 */
export function verdictFor(detail: string): LoadVerdict {
  if (/alignment_heads/i.test(detail)) return 'give-up'
  // A missing file is a 404 from the hub, and it means this repo simply does not
  // publish these weights — which is the ladder working, not the network
  // failing, however much the two look alike.
  if (/could not locate|not found|404/i.test(detail)) return 'try-next'
  if (/failed to fetch|networkerror|network error|load failed|net::/i.test(detail)) return 'give-up'
  return 'try-next'
}

/** How to describe a set of weights to someone who did not choose them. */
export function describeWeights(dtype: string): string {
  if (dtype === 'fp32') return 'full-precision weights — a larger download'
  if (dtype === 'q8') return 'compressed weights'
  return `${dtype} weights`
}

/**
 * What to tell the user when a model will not load.
 *
 * Says what was being attempted, because the underlying errors do not, and names
 * every set of weights that was tried — the interesting part is usually that all
 * of them failed the same way, which points at the repo rather than at the
 * browser.
 */
export function loadFailureMessage(model: string, attempts: readonly string[]): string {
  const first = attempts[0] ?? ''

  if (/alignment_heads/i.test(first)) {
    return (
      `"${model}" has no word-level timing in it, so there is nothing for the highlight to ` +
      `follow. Pick a model published with alignment heads — the "_timestamped" repos are built ` +
      `for this — in Settings.`
    )
  }
  if (verdictFor(first) === 'give-up') {
    return (
      `The speech model "${model}" could not be downloaded. It comes from huggingface.co the ` +
      `first time you caption in the browser, so this needs a connection that can reach it. ` +
      `(${first})`
    )
  }

  return (
    `The speech model "${model}" downloaded but would not run in this browser, in any of the ` +
    `${attempts.length} formats it is published in. Try another model in Settings — ` +
    `"onnx-community/whisper-tiny.en_timestamped" is a smaller one. ` +
    `Attempts: ${attempts.join(' · ')}`
  )
}
