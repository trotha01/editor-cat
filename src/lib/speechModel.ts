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
import type { SpeechModelAttempt } from './models'

/** What to do about a failed attempt to load one set of weights. */
export type LoadVerdict =
  /** These weights are no good, but another set might be. */
  | 'try-next'
  /** Nothing about the weights would help. Stop and say so. */
  | 'give-up'

/**
 * Whether a model cannot time individual words.
 *
 * The one failure here that is not a failure at all, and the only one that does
 * not surface while loading: alignment heads live in the generation config,
 * which is not read until the model is first asked to transcribe. A model
 * without them still emits the timestamp tokens that bound a phrase, which is
 * enough to caption from — so the worker asks again the other way rather than
 * giving up on a model that loaded perfectly well.
 */
export function isMissingAlignment(detail: string): boolean {
  return /alignment_heads/i.test(detail)
}

/**
 * The one error nothing else on the ladder can survive.
 *
 * A network that cannot reach the hub will not reach it for the next file
 * either, and walking a ladder against it just repeats the same failure. Every
 * other failure is about one particular way of opening one particular model, and
 * the ladder exists to try another.
 */
export function verdictFor(detail: string): LoadVerdict {
  // A missing file is a 404 from the hub, and it means this repo simply does not
  // publish these weights — which is the ladder working, not the network
  // failing, however much the two look alike.
  if (/could not locate|not found|404/i.test(detail)) return 'try-next'
  if (/failed to fetch|networkerror|network error|load failed|net::/i.test(detail)) return 'give-up'
  return 'try-next'
}

/** How to describe one way of opening a model to someone who did not choose it. */
export function describeAttempt(attempt: SpeechModelAttempt): string {
  // The model comes first when it is not the one they configured, because that
  // is the part that changes what the transcript says rather than how long it
  // takes to produce.
  const prefix = attempt.model ? `${attempt.model}, ` : ''
  const weights =
    attempt.dtype === 'fp32'
      ? 'full-precision weights — a larger download'
      : attempt.dtype === 'q8'
        ? 'compressed weights'
        : `${attempt.dtype} weights`

  return `${prefix}${weights}`
}

/** The same, short enough to sit in a list of failures. */
export function labelAttempt(attempt: SpeechModelAttempt): string {
  return attempt.model ? `${attempt.model} ${attempt.dtype}` : attempt.dtype
}

/**
 * What to tell the user when a model will not load.
 *
 * Says what was being attempted, because the underlying errors do not, and names
 * every set of weights that was tried — the interesting part is usually that all
 * of them failed the same way, which points at the repo rather than at the
 * browser.
 *
 * Only ever reached by a genuine load failure. A model that loads and then turns
 * out not to time words is handled where it happens and never gets here.
 */
export function loadFailureMessage(model: string, attempts: readonly string[]): string {
  const last = attempts[attempts.length - 1] ?? ''

  if (verdictFor(last) === 'give-up') {
    return (
      `The speech model "${model}" could not be downloaded. It comes from huggingface.co the ` +
      `first time you caption in the browser, so this needs a connection that can reach it. ` +
      `(${last})`
    )
  }

  return (
    `No speech model would run in this browser: "${model}" was tried ${attempts.length} ways, ` +
    `including a fallback from a different publisher. That is unusual enough to be worth ` +
    `reporting — and in the meantime another repo id in Settings may work, ` +
    `"Xenova/whisper-tiny.en" being a small one. ` +
    `Attempts: ${attempts.join(' · ')}`
  )
}
