/**
 * The browser's view of a stored Google Drive connection.
 *
 * Thin wrapper over `/api/google/*`, which holds the refresh token this side
 * deliberately never sees. Everything here is authorised with the user's own
 * session token — the same one the fal proxy checks, minted from their Netlify
 * Identity sign-in — because the connection is filed under their account id.
 *
 * A deployment that has not been set up for this answers `durable: false` and
 * says why. There is no degraded mode behind that: the editor writes to Drive,
 * so a site that cannot keep the connection cannot let anyone in, and the gate
 * shows the reason instead of a button that would fail after consent.
 */
import { supabaseAccessToken } from '../supabase/session'

const BASE = '/api/google'

/**
 * Why this deployment cannot keep Drive connected.
 *
 * Mirrors the union in netlify/functions/google.ts, plus nothing: `unreachable`
 * covers both "the store did not answer the function" and "the function did not
 * answer us", because the two are the same sentence to whoever is reading it,
 * and the function log already separates them for whoever is fixing it.
 */
export type StatusProblem = 'not-configured' | 'no-table' | 'unreachable'

const PROBLEMS: readonly string[] = ['not-configured', 'no-table', 'unreachable']

export interface ConnectionStatus {
  /** Whether this deployment can store a connection at all. */
  durable: boolean
  /** Whether this user has one stored. */
  connected: boolean
  /** Why not, when `durable` is false. */
  problem?: StatusProblem
  /**
   * What the store said, when it said anything — PostgREST's status, code and
   * message. Present only for a signed-in caller, and only worth showing to
   * someone who could act on it.
   */
  detail?: string
}

/** Beyond this it is not a diagnostic any more, it is a payload. */
const DETAIL_LIMIT = 300

export interface DriveGrant {
  accessToken: string
  /** Seconds until it stops working. */
  expiresIn: number
  scope: string
}

/** Raised when the account has no stored connection, which is not a failure. */
export class NoConnectionError extends Error {
  constructor() {
    super('No Google Drive connection is saved for this account.')
    this.name = 'NoConnectionError'
  }
}

/**
 * Raised when the Supabase session was not accepted just now.
 *
 * Deliberately distinct from `NotDurableError`: this is a moment, not a property
 * of the deployment. A laptop waking from sleep can present a token that expired
 * while it slept, and treating that as "this site cannot store connections"
 * would give up on the stored connection for the rest of the session.
 */
export class SessionRequiredError extends Error {
  constructor() {
    super('Sign in again to reach Google Drive.')
    this.name = 'SessionRequiredError'
  }
}

/** Raised when the stored connection stopped working and consent is needed again. */
export class ConnectionExpiredError extends Error {
  constructor(message = 'Your Google connection expired. Connect Drive again in Settings.') {
    super(message)
    this.name = 'ConnectionExpiredError'
  }
}

/** Raised when this deployment has no server-side connection support. */
export class NotDurableError extends Error {
  constructor() {
    super('This site does not keep Drive connected between visits.')
    this.name = 'NotDurableError'
  }
}

/**
 * How long to wait on our own function before deciding nothing is answering.
 *
 * Only applied to the status check, which the sign-in screen waits on before it
 * can draw a button. A request that hangs there leaves no way into the app at
 * all, and falling back to the flow that needs no server is far better than a
 * spinner that never resolves.
 */
const STATUS_TIMEOUT_MS = 8000

/** Google's own default, used when a response omits `expires_in`. */
const DEFAULT_LIFETIME_SECONDS = 3600

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await supabaseAccessToken()
  return await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      // Absent on a build with no Supabase project behind it. The endpoint
      // answers 503 in that case, which is the signal to use the fallback.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
}

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Reads a JSON object from one of our own endpoints.
 *
 * A static host with an SPA fallback answers `/api/*` with the app's own
 * index.html and a cheerful 200. Parsing that throws a `SyntaxError`, which
 * would reach the user as gibberish — so an unreadable body is reported as this
 * site simply not having the endpoint, which every caller already handles.
 */
async function readBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new NotDurableError()
  }
  if (!body || typeof body !== 'object') throw new NotDurableError()
  return body as Record<string, unknown>
}

/**
 * Whether this deployment stores connections, and whether this user has one.
 *
 * Answered without calling Google, so it is cheap enough to ask on every load
 * before deciding whether to resume a connection or offer the button.
 */
export async function connectionStatus(): Promise<ConnectionStatus> {
  // Every way of not getting an answer lands here: offline, timed out, a 404
  // from a static host with no functions behind it, or a body that is not the
  // shape this expects. None of them is evidence about how the site is set up,
  // so none of them may claim it is set up wrongly.
  const noAnswer: ConnectionStatus = { durable: false, connected: false, problem: 'unreachable' }

  try {
    const response = await call('/status', { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    if (!response.ok) return noAnswer

    const body = await readBody(response)
    if (typeof body.durable !== 'boolean' || typeof body.connected !== 'boolean') return noAnswer
    if (body.durable) return { durable: true, connected: body.connected }

    return {
      durable: false,
      connected: body.connected,
      // An unlabelled `durable: false` reads as "not configured" because that is
      // the only thing it ever meant: the function says false deliberately, and
      // before it named reasons, being unconfigured was the only one it had.
      problem: PROBLEMS.includes(body.problem as string)
        ? (body.problem as StatusProblem)
        : 'not-configured',
      // Truncated here as well as at the source: this ends up on screen, and
      // what reaches it is only as trustworthy as whatever answered /api.
      ...(typeof body.detail === 'string' && body.detail
        ? { detail: body.detail.slice(0, DETAIL_LIMIT) }
        : {}),
    }
  } catch {
    return noAnswer
  }
}

function toGrant(body: Record<string, unknown>): DriveGrant {
  if (typeof body.access_token !== 'string') throw new NotDurableError()
  return {
    accessToken: body.access_token,
    expiresIn: Number.isFinite(body.expires_in)
      ? Number(body.expires_in)
      : DEFAULT_LIFETIME_SECONDS,
    scope: typeof body.scope === 'string' ? body.scope : '',
  }
}

/**
 * Exchanges the consent code for tokens and records the connection.
 *
 * `durable` comes back false when Google declined to reissue a refresh token and
 * there was none stored already. The access token still works, so the connection
 * is real — it just will not outlive the hour, and the caller says so rather
 * than letting the user find out later.
 */
export async function saveConnection(code: string): Promise<DriveGrant & { durable: boolean }> {
  const response = await call('/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })

  if (!response.ok) {
    if (response.status === 503) throw new NotDurableError()
    throw new Error(await messageFrom(response, 'Could not connect Google Drive.'))
  }

  const body = await readBody(response)
  return { ...toGrant(body), durable: body.durable !== false }
}

/** A fresh Drive access token minted from the stored refresh token. */
export async function requestAccessToken(): Promise<DriveGrant> {
  const response = await call('/token', { method: 'POST' })

  if (!response.ok) {
    if (response.status === 404) throw new NoConnectionError()
    if (response.status === 409) {
      throw new ConnectionExpiredError(
        await messageFrom(response, 'Your Google connection expired. Connect Drive again.'),
      )
    }
    if (response.status === 401) throw new SessionRequiredError()
    if (response.status === 503) throw new NotDurableError()
    throw new Error(await messageFrom(response, 'Could not refresh your Google Drive access.'))
  }

  return toGrant(await readBody(response))
}

/** Forgets the stored connection and revokes it at Google. */
export async function clearConnection(): Promise<void> {
  const response = await call('/disconnect', { method: 'POST' })
  // A deployment with no stored connection to clear is already in the state the
  // caller wanted, so neither 404 nor 503 is worth raising.
  if (!response.ok && response.status !== 404 && response.status !== 503) {
    throw new Error(await messageFrom(response, 'Could not disconnect Google Drive.'))
  }
}
