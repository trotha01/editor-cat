/**
 * The browser's view of Drive access, which Auth0 holds on the user's behalf.
 *
 * Thin wrapper over `/api/google/*`, which exchanges the caller's Auth0 token
 * for a Google one through Token Vault. Nothing durable lives on this side, and
 * nothing durable lives on the function's side either any more — the Google
 * refresh token is Auth0's, and neither half of this app ever sees it.
 *
 * Authorised with the Auth0 access token — the same one `/api/fal/*` takes, and
 * not the ID token Supabase gets. That token is the subject of the exchange, so
 * it is the one thing that will do: see netlify/functions/google.ts.
 *
 * A deployment that has not been set up for this answers `durable: false` and
 * says why. There is no degraded mode behind that: the editor writes to Drive,
 * so a site that cannot reach it cannot let anyone in, and the gate shows the
 * reason instead of a button that would fail after consent.
 */
import { auth0Token } from '../auth0/client'

const BASE = '/api/google'

/**
 * Why this deployment cannot reach Drive.
 *
 * Mirrors the shapes netlify/functions/google.ts answers with: `not-configured`
 * is a deployment missing its Token Vault credentials, and `unreachable` covers
 * both "Auth0 did not answer the function" and "the function did not answer us",
 * because the two are the same sentence to whoever is reading it.
 */
export type StatusProblem = 'not-configured' | 'unreachable'

const PROBLEMS: readonly string[] = ['not-configured', 'unreachable']

export interface ConnectionStatus {
  /** Whether this deployment can reach Drive at all. */
  durable: boolean
  /** Whether this user has a usable Google grant. */
  connected: boolean
  /** Why not, when `durable` is false. */
  problem?: StatusProblem
  /**
   * Which step of the setup answered no, in the server's own words.
   *
   * Never shown to a visitor — there is nothing here they could act on. It
   * exists because the half-dozen ways of ending up unconnected are otherwise
   * identical from the outside: same JSON, same screen, and only the function
   * log knows which, on a deploy preview whose logs most people never find.
   * Printed to the console instead, where whoever is standing the deployment up
   * is already looking.
   */
  detail?: string
}

export interface DriveGrant {
  accessToken: string
  /** Seconds until it stops working. */
  expiresIn: number
  scope: string
}

/** Raised when the account has no usable Google grant, which is not a failure. */
export class NoConnectionError extends Error {
  constructor() {
    super('No Google Drive access is granted for this account.')
    this.name = 'NoConnectionError'
  }
}

/**
 * Raised when the Auth0 session was not accepted just now.
 *
 * Deliberately distinct from `NotDurableError`: this is a moment, not a property
 * of the deployment. A laptop waking from sleep can present a token that expired
 * while it slept, and treating that as "this site cannot reach Drive" would give
 * up on Drive for the rest of the session.
 */
export class SessionRequiredError extends Error {
  constructor() {
    super('Sign in again to reach Google Drive.')
    this.name = 'SessionRequiredError'
  }
}

/** Raised when the grant stopped working and consent is needed again. */
export class ConnectionExpiredError extends Error {
  constructor(message = 'Your Google connection expired. Sign in again to restore it.') {
    super(message)
    this.name = 'ConnectionExpiredError'
  }
}

/** Raised when this deployment cannot reach Drive at all. */
export class NotDurableError extends Error {
  constructor(message = 'This site is not set up for Google Drive.') {
    super(message)
    this.name = 'NotDurableError'
  }
}

async function authorization(): Promise<string> {
  const token = await auth0Token()
  if (!token) throw new SessionRequiredError()
  return `Bearer ${token}`
}

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Whether this deployment can reach Drive, and whether this account may.
 *
 * Asked before the gate draws anything. Every way of not getting an answer
 * counts as `unreachable`: none of them is evidence about how the site is
 * configured.
 */
export async function connectionStatus(): Promise<ConnectionStatus> {
  let headers: Record<string, string> = {}
  try {
    headers = { authorization: await authorization() }
  } catch {
    // Signed out. The deployment question is still worth asking, and answering
    // it needs no token.
  }

  try {
    const response = await fetch(`${BASE}/status`, { headers })
    if (!response.ok) return { durable: false, connected: false, problem: 'unreachable' }

    const body = (await response.json()) as {
      durable?: unknown
      connected?: unknown
      problem?: unknown
      detail?: unknown
    }

    const detail = typeof body.detail === 'string' ? body.detail : undefined

    // Printed rather than shown. Ending up here is nearly always a half-finished
    // deployment, and the person who can finish it is the one with the console
    // open — a visitor has nothing to do with `token-rejected` but read it.
    if (detail && body.connected !== true) {
      console.warn(`[editor-cat] Google Drive is not connected — ${detail}`)
    }

    return {
      durable: body.durable === true,
      connected: body.connected === true,
      ...(typeof body.problem === 'string' && PROBLEMS.includes(body.problem)
        ? { problem: body.problem as StatusProblem }
        : {}),
      ...(detail ? { detail } : {}),
    }
  } catch {
    // A static host with an SPA fallback answers /api/* with index.html and a
    // cheerful 200, which does not parse as status either.
    return { durable: false, connected: false, problem: 'unreachable' }
  }
}

/** A fresh Google access token, exchanged from this session's Auth0 token. */
export async function requestAccessToken(): Promise<DriveGrant> {
  const response = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { authorization: await authorization() },
  })

  if (response.status === 401) throw new SessionRequiredError()
  if (response.status === 409) throw new ConnectionExpiredError(await messageFrom(response, ''))
  if (response.status === 503) throw new NotDurableError(await messageFrom(response, ''))
  if (!response.ok) {
    throw new Error(await messageFrom(response, 'Could not get access to your Google Drive.'))
  }

  const body = (await response.json()) as {
    accessToken?: unknown
    expiresIn?: unknown
    scope?: unknown
  }

  if (typeof body.accessToken !== 'string' || !body.accessToken) throw new NoConnectionError()

  return {
    accessToken: body.accessToken,
    expiresIn: Number.isFinite(body.expiresIn) ? Number(body.expiresIn) : 3600,
    scope: typeof body.scope === 'string' ? body.scope : '',
  }
}
