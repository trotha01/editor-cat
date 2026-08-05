/**
 * The browser's view of a stored Google Drive connection.
 *
 * Thin wrapper over `/api/google/*`, which holds the refresh token this side
 * deliberately never sees. Everything here is authorised with the user's own
 * Supabase session token — the same one the fal proxy checks — because the
 * connection is filed under their account id.
 *
 * A deployment that has not been set up for this (no client secret, no service
 * role key) answers `durable: false`, and the caller falls back to the in-memory
 * token flow in gis.ts. That fallback is why `npm run dev` against a bare
 * checkout still works exactly as it did.
 */
import { currentAccessToken } from '../../state/useAuthStore'

const BASE = '/api/google'

export interface ConnectionStatus {
  /** Whether this deployment can store a connection at all. */
  durable: boolean
  /** Whether this user has one stored. */
  connected: boolean
  scope: string
}

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

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = currentAccessToken()
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
 * Whether this deployment stores connections, and whether this user has one.
 *
 * Answered without calling Google, so it is cheap enough to ask on every load
 * before deciding whether to resume a connection or offer the button.
 */
export async function connectionStatus(): Promise<ConnectionStatus> {
  const unsupported: ConnectionStatus = { durable: false, connected: false, scope: '' }

  try {
    const response = await call('/status')
    // 404 covers the case that matters most in practice: an older deploy, or a
    // local `vite dev` with no functions behind it at all.
    if (!response.ok) return unsupported

    // A static host with an SPA fallback answers /api/* with the app's own
    // index.html and a cheerful 200, so the shape is checked rather than
    // trusted. Anything unrecognisable means there is no endpoint here.
    const body = (await response.json()) as Partial<ConnectionStatus>
    if (typeof body.durable !== 'boolean' || typeof body.connected !== 'boolean') return unsupported
    return { durable: body.durable, connected: body.connected, scope: body.scope ?? '' }
  } catch {
    // Offline, or /api is not being served. Either way there is no stored
    // connection to resume, and the caller has a fallback.
    return unsupported
  }
}

function toGrant(body: { access_token: string; expires_in: number; scope?: string }): DriveGrant {
  return {
    accessToken: body.access_token,
    expiresIn: Number.isFinite(body.expires_in) ? body.expires_in : 3600,
    scope: body.scope ?? '',
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

  const body = (await response.json()) as {
    access_token: string
    expires_in: number
    scope?: string
    durable?: boolean
  }
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

  return toGrant(
    (await response.json()) as { access_token: string; expires_in: number; scope?: string },
  )
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
