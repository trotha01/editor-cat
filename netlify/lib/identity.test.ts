import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdentityUnavailableError, identityUrl, identityUser } from './identity'

/**
 * Asking Netlify Identity who a token belongs to.
 *
 * The distinction that matters here is between "Identity says no" and "Identity
 * did not say anything". They arrive as the same failed request and mean
 * opposite things: the first is a visitor who should sign in again, the second
 * is an outage that signing in again cannot fix. Collapsing them tells someone
 * to do the one thing that will not help.
 */
const ENV_KEYS = ['NETLIFY_IDENTITY_URL', 'IDENTITY_ENDPOINT'] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.unstubAllGlobals()
})

const REQUEST_URL = 'https://site.example/api/session'

/** Answers one canned response, and records what was asked. */
function serve(response: Response | Error) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
  })
  return calls
}

function userResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('identityUrl', () => {
  it('derives the endpoint from the request, since Identity is on the same site', () => {
    expect(identityUrl(REQUEST_URL)).toBe('https://site.example/.netlify/identity')
  })

  it('takes an override, for a proxy that rewrites the host in front of the site', () => {
    process.env.NETLIFY_IDENTITY_URL = 'https://elsewhere.example/.netlify/identity/'
    expect(identityUrl(REQUEST_URL)).toBe('https://elsewhere.example/.netlify/identity')
  })

  it('accepts Netlify’s own name for the same thing', () => {
    process.env.IDENTITY_ENDPOINT = 'https://injected.example/.netlify/identity'
    expect(identityUrl(REQUEST_URL)).toBe('https://injected.example/.netlify/identity')
  })
})

describe('identityUser', () => {
  it('returns the account behind a token it accepts', async () => {
    const calls = serve(userResponse({ id: 'user-uuid', email: 'someone@example.com' }))

    await expect(identityUser('a-token', REQUEST_URL)).resolves.toEqual({
      id: 'user-uuid',
      email: 'someone@example.com',
    })

    expect(calls[0]?.url).toBe('https://site.example/.netlify/identity/user')
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer a-token' })
  })

  it('answers null for a token Identity refuses, which is an answer', async () => {
    serve(new Response('unauthorized', { status: 401 }))

    await expect(identityUser('stale-token', REQUEST_URL)).resolves.toBeNull()
  })

  it('raises rather than answering null when Identity cannot be reached', async () => {
    // A null here would read as "your session is bad" and send someone back to a
    // sign-in screen that is equally broken.
    serve(new Error('getaddrinfo ENOTFOUND'))

    await expect(identityUser('a-token', REQUEST_URL)).rejects.toBeInstanceOf(
      IdentityUnavailableError,
    )
  })

  it('raises on a server error, which says nothing about the token', async () => {
    serve(new Response('boom', { status: 502 }))

    await expect(identityUser('a-token', REQUEST_URL)).rejects.toBeInstanceOf(
      IdentityUnavailableError,
    )
  })

  it('refuses the SPA fallback dressed up as a 200', async () => {
    // A site with Identity switched off has no such endpoint, and the catch-all
    // redirect serves index.html with a cheerful 200. That is not a user, and
    // treating it as one would sign everybody in as nobody.
    serve(new Response('<!doctype html><title>editor-cat</title>', { status: 200 }))

    await expect(identityUser('a-token', REQUEST_URL)).rejects.toBeInstanceOf(
      IdentityUnavailableError,
    )
  })

  it('treats a user with no id as no user at all', async () => {
    // The id is the key every row this app stores is filed under. A row keyed on
    // `undefined` is worse than a refused sign-in.
    serve(userResponse({ email: 'someone@example.com' }))

    await expect(identityUser('a-token', REQUEST_URL)).resolves.toBeNull()
  })

  it('copes with an account that has no address', async () => {
    serve(userResponse({ id: 'user-uuid' }))

    await expect(identityUser('a-token', REQUEST_URL)).resolves.toEqual({
      id: 'user-uuid',
      email: '',
    })
  })
})
