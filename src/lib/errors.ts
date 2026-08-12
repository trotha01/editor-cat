/**
 * Provider errors, translated into something a person can act on.
 *
 * A raw "422 Unprocessable Entity" tells the user nothing about whether they
 * typed the key wrong, ran out of credit, or tripped a content filter — which
 * are three completely different next steps.
 */

export class ProviderError extends Error {
  readonly status: number
  readonly provider: 'fal.ai' | 'ElevenLabs'
  readonly detail: string | undefined

  constructor(provider: 'fal.ai' | 'ElevenLabs', status: number, message: string, detail?: string) {
    super(message)
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
    this.detail = detail
  }
}

/** Pulls a human-readable message out of whatever shape the provider returned. */
export function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim()) return body.trim()
  if (!body || typeof body !== 'object') return undefined

  const record = body as Record<string, unknown>

  if (typeof record.error === 'string') return record.error
  if (typeof record.message === 'string') return record.message

  // fal validation errors: { detail: [{ msg, loc }] }
  const detail = record.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          const entry = item as { msg?: unknown; loc?: unknown }
          const where = Array.isArray(entry.loc) ? ` (${entry.loc.join('.')})` : ''
          return `${String(entry.msg)}${where}`
        }
        return typeof item === 'string' ? item : null
      })
      .filter((part): part is string => Boolean(part))
    if (parts.length) return parts.join('; ')
  }

  // ElevenLabs: { detail: { status, message } }
  if (detail && typeof detail === 'object') {
    const entry = detail as { message?: unknown; status?: unknown }
    if (typeof entry.message === 'string') return entry.message
    if (typeof entry.status === 'string') return entry.status
  }

  return undefined
}

/**
 * Maps a status code onto advice about what to actually do next.
 *
 * Both providers are reached with the deployment's own key now, which changed
 * what these codes mean. They used to differ: fal was the site's and ElevenLabs
 * was the user's, so a rejected ElevenLabs key was something the reader could go
 * and fix in Settings. There is no Settings field any more, and sending someone
 * to look for one is worse than telling them plainly that this is not theirs to
 * fix. What is left is the same three sentences for both: your session, the
 * site's account, or the site's setup.
 *
 * A 403 has one more meaning than it used to, and it is deliberately not spelled
 * out here: our own proxies answer 403 for an account that is not on this
 * deployment's list, and for an endpoint it will not forward. Both arrive with a
 * `detail` saying exactly which, and `toDisplayMessage` prints it after this
 * line — so this stays the general case and the specific one speaks for itself.
 */
export function explainStatus(provider: 'fal.ai' | 'ElevenLabs', status: number): string {
  switch (status) {
    case 401:
      return 'This site could not confirm that you are signed in. Sign in again, then retry.'
    case 403:
      return 'This site would not allow that. The details below say why.'
    case 402:
      return `This site's ${provider} account is out of credit, so this is paused. Nothing you can fix from here.`
    case 503:
      // Both proxies answer 503 when the deployment has not been given the key
      // they need, so this is far more likely to be a setup problem than an
      // outage at the provider.
      return `This site is not set up for ${provider === 'fal.ai' ? 'generation' : 'voice generation'}. Whoever deployed it needs to add a ${provider} key to the site environment.`
    case 404:
      return `That ${provider} model ID does not exist. Provider catalogues change often — pick another model, or set a custom ID in the model picker.`
    case 422:
      return `${provider} rejected these settings. The details below say which field is at fault.`
    case 429:
      return `${provider} is rate limiting you. Wait a moment and try again.`
    case 504:
      // The one 5xx that is not retried automatically — see `isRetryableStatus`
      // — so it cannot borrow the "usually transient, try again" line the others
      // get. Following that advice here means waiting out the same slow request
      // a second time, and where the request is slow because of its own size,
      // that is the one thing guaranteed not to work.
      return `${provider} did not answer that in time. Sending it again would be the same request taking the same time, so give it less to do at once — a shorter clip, or fewer of them — or come back to it later.`
    default:
      if (status >= 500)
        return `${provider} had a server error. This is usually transient — try again.`
      return `${provider} returned an error.`
  }
}

/**
 * Which status codes describe the moment rather than the request.
 *
 * A 429 is the provider saying *not yet* and a 5xx is it saying *something
 * broke at our end*. Both are answers that change on their own, and both are
 * what a caption run actually meets, because captioning a timeline is a queue
 * of requests fired one after another at a service that meters them.
 *
 * Everything else is a decision already made, and it will be made again the
 * same way: a rejected key is still rejected in two seconds, a content filter
 * still objects to the same audio, and a model ID that does not exist does not
 * start existing. Asking three times over only makes that failure slower to
 * report, with the user watching a spinner for something settled on the first
 * try.
 *
 * 504 is the deliberate exception among the 5xx, and it was learned the hard
 * way. A timeout says the request was too slow, and a retry is the same request
 * — the same bytes uploaded, the same work asked for, the same clock. Where the
 * slowness is the payload, which for a caption chunk it always is because the
 * audio travels inline as base64, the retry cannot do anything but fail the
 * same way a few seconds later and a few megabytes heavier. It is also the only
 * 5xx this app raises about itself: `run` answers 504 when a job outlives its
 * `timeoutMs`, and repeating that would turn one fifteen-minute wait into three.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 504)
}

/**
 * Whether asking the same question again could plausibly get a different
 * answer.
 *
 * A `fetch` that never got an answer at all rejects with a `TypeError` rather
 * than a status — a dropped connection, or a proxy that closed the socket. That
 * is the most transient failure of the lot, so it counts too. Anything else
 * thrown is something this app does not recognise well enough to repeat safely,
 * and guessing would mean doing unknown work twice.
 */
export function isRetryable(error: unknown): boolean {
  // Never. A cancellation is the user's decision, not a fault to work around,
  // and retrying one would mean ignoring the button they just pressed.
  if (isAbort(error)) return false
  if (error instanceof ProviderError) return isRetryableStatus(error.status)
  return error instanceof TypeError
}

/**
 * A failure that was already asked about more than once.
 *
 * Worth distinguishing from a first-attempt failure only because of how it
 * reads: "rate limited" invites the user to press the button again straight
 * away, which is the one thing that will not work, while the same words plus
 * "tried 3 times" say that the wait needs to be longer than a press. It carries
 * the original as its `cause` and borrows its wording, so nothing downstream
 * has to know this class exists to render it sensibly.
 */
export class RetriedError extends Error {
  readonly attempts: number

  constructor(cause: unknown, attempts: number) {
    super(toDisplayMessage(cause), { cause })
    this.name = 'RetriedError'
    this.attempts = attempts
  }
}

/**
 * A cancellation, as opposed to a failure.
 *
 * Spelled out once because the check is easy to write slightly differently in
 * each place that needs it, and every one of those places treats the two kinds
 * of thrown value as opposites: an abort travels all the way up and says
 * nothing, a failure is collected and shown.
 */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export async function providerErrorFrom(
  provider: 'fal.ai' | 'ElevenLabs',
  response: Response,
): Promise<ProviderError> {
  let body: unknown
  try {
    const text = await response.text()
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  } catch {
    body = undefined
  }

  const detail = extractMessage(body)
  return new ProviderError(
    provider,
    response.status,
    explainStatus(provider, response.status),
    detail,
  )
}

/** Renders any thrown value as a single line suitable for the UI. */
export function toDisplayMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return error.detail ? `${error.message} — ${error.detail}` : error.message
  }
  if (isAbort(error)) return 'Cancelled.'
  if (error instanceof Error) return error.message
  return String(error)
}
