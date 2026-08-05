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
 * The two providers need different advice for the same codes. ElevenLabs is
 * still bring-your-own-key, so a rejection is something the user can fix in
 * Settings. fal is reached with the site's own key, so the same codes mean
 * either "your session lapsed" or "the operator needs to fix something" — and
 * telling that user to check a Settings field they cannot see is worse than
 * saying nothing.
 */
export function explainStatus(provider: 'fal.ai' | 'ElevenLabs', status: number): string {
  const siteOwnsKey = provider === 'fal.ai'

  switch (status) {
    case 401:
    case 403:
      return siteOwnsKey
        ? 'This site could not confirm that you are signed in. Sign in again, then retry.'
        : `Your ${provider} API key was rejected. Check it in Settings — keys are easy to paste with a trailing space.`
    case 402:
      return siteOwnsKey
        ? "This site's fal.ai account is out of credit, so generation is paused. Nothing you can fix from here."
        : `Your ${provider} account is out of credit. Top it up and try again.`
    case 503:
      // Our own proxy answers 503 when the deployment has no fal key, so for
      // fal this is far more likely to be a setup problem than an outage.
      return siteOwnsKey
        ? 'This site is not set up for generation. Whoever deployed it needs to add a fal.ai key to the site environment.'
        : `${provider} had a server error. This is usually transient — try again.`
    case 404:
      return `That ${provider} model ID does not exist. Provider catalogues change often — pick another model, or set a custom ID in the model picker.`
    case 422:
      return `${provider} rejected these settings. The details below say which field is at fault.`
    case 429:
      return `${provider} is rate limiting you. Wait a moment and try again.`
    default:
      if (status >= 500)
        return `${provider} had a server error. This is usually transient — try again.`
      return `${provider} returned an error.`
  }
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
  if (error instanceof DOMException && error.name === 'AbortError') return 'Cancelled.'
  if (error instanceof Error) return error.message
  return String(error)
}
