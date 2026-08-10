/**
 * The Supabase session, minted from a Netlify Identity sign-in.
 *
 * Supabase will not accept a Netlify Identity token: row-level security reads
 * `auth.uid()` out of a JWT signed with the project's own secret, and Identity's
 * is signed with Netlify's. So `/api/session` — the one place that holds that
 * secret — verifies the Identity token and signs a Supabase-shaped session
 * carrying the same user id. See netlify/functions/session.ts.
 *
 * This module is the browser's half of that: it asks for one, holds it until it
 * is nearly expired, and asks again. The token is what the Supabase client sends
 * on every query (see client.ts) and what this site's own functions verify
 * (`/api/fal/*`, `/api/google/*`), so nothing else needs to know that two
 * identity systems are involved at all.
 *
 * Held in memory rather than storage. It is a live credential for the user's own
 * rows, it is cheap to replace, and the durable half — the Identity session that
 * mints it — is already persisted by gotrue-js.
 */
import { currentIdentityUser, identityToken } from '../netlify/identity'

const ENDPOINT = '/api/session'

/** Raised when there is no Identity session behind the request any more. */
export class SignInRequiredError extends Error {
  constructor(message = 'Sign in again to continue.') {
    super(message)
    this.name = 'SignInRequiredError'
  }
}

/** Raised when the deployment cannot mint sessions at all. */
export class SessionNotConfiguredError extends Error {
  constructor(message = 'This site is not set up for sign-in.') {
    super(message)
    this.name = 'SessionNotConfiguredError'
  }
}

interface Minted {
  token: string
  /** Epoch millis, already reduced by a safety margin. */
  expiresAt: number
}

/** Renew a minute early; a token that expires mid-save fails the save. */
const EXPIRY_MARGIN_MS = 60_000

/** Used when a response omits `expires_in`, matching what the function issues. */
const DEFAULT_LIFETIME_SECONDS = 3600

let minted: Minted | null = null

function validToken(): string | null {
  if (minted && minted.expiresAt > Date.now()) return minted.token
  return null
}

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

async function mint(): Promise<string> {
  let identityJwt: string | null
  try {
    identityJwt = await identityToken()
  } catch {
    // gotrue-js clears the stored session when a refresh is refused, so this is
    // the shape an Identity session that has run out arrives in.
    throw new SignInRequiredError()
  }
  if (!identityJwt) throw new SignInRequiredError()

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${identityJwt}` },
  })

  if (!response.ok) {
    if (response.status === 401) throw new SignInRequiredError()
    if (response.status === 503) throw new SessionNotConfiguredError()
    throw new Error(await messageFrom(response, 'Could not start a session for your account.'))
  }

  let body: { access_token?: unknown; expires_in?: unknown }
  try {
    body = (await response.json()) as typeof body
  } catch {
    // A static host with an SPA fallback answers /api/* with index.html and a
    // cheerful 200. That is not a session.
    throw new SessionNotConfiguredError()
  }

  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new SessionNotConfiguredError()
  }

  const lifetime = Number.isFinite(body.expires_in)
    ? Number(body.expires_in)
    : DEFAULT_LIFETIME_SECONDS

  minted = {
    token: body.access_token,
    expiresAt: Date.now() + lifetime * 1000 - EXPIRY_MARGIN_MS,
  }
  return minted.token
}

/** The mint currently running, shared by everyone waiting on it. */
let minting: Promise<string> | null = null

/**
 * A usable Supabase session token, minting one when the last has aged out.
 *
 * Concurrent callers share one mint. Supabase calls this per request and the
 * editor saves, syncs assets and uploads at the same time, so without this a
 * single expiry would fan out into a burst of identical requests.
 *
 * Answers null rather than throwing when nobody is signed in: that is the
 * ordinary state of a signed-out page, and the Supabase client treats a null
 * token as "send the anon key alone", which row-level security then refuses.
 */
export async function supabaseAccessToken(): Promise<string | null> {
  const current = validToken()
  if (current) return current
  if (!currentIdentityUser()) return null

  if (!minting) {
    const attempt = mint()
    minting = attempt
    const clear = () => {
      if (minting === attempt) minting = null
    }
    attempt.then(clear, clear)
  }

  return await minting
}

/** Drops the held session, so the next caller mints a fresh one. */
export function clearSupabaseSession(): void {
  minted = null
  minting = null
}

export interface SessionReadiness {
  ready: boolean
  problem?: 'not-configured' | 'unreachable'
}

/**
 * Whether this deployment can mint sessions, asked before the gate draws a
 * button.
 *
 * A site missing the signing secret can send someone all the way through
 * Google's consent screen and then have nowhere to put the result, which is a
 * poor way to find out. Every way of not getting an answer counts as
 * `unreachable`: none of them is evidence about how the site is configured.
 */
export async function sessionReadiness(): Promise<SessionReadiness> {
  try {
    const response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return { ready: false, problem: 'unreachable' }

    const body = (await response.json()) as { ready?: unknown }
    if (body.ready === true) return { ready: true }
    return { ready: false, problem: 'not-configured' }
  } catch {
    return { ready: false, problem: 'unreachable' }
  }
}
