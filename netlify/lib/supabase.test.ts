import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requireSession } from './auth'
import { storeConfig } from './googleConnections'
import { supabaseProjectUrl } from './supabase'

const PROJECT = 'https://abcdefgh.supabase.co'

const ENV_KEYS = [
  'SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'SUPABASE_JWT_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FAL_PROXY_ALLOW_ANONYMOUS',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  // Vitest reuses worker processes, so environment changes have to be undone or
  // they leak into whatever file runs next.
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('supabaseProjectUrl', () => {
  it('is empty when the deployment has not been told which project it belongs to', () => {
    expect(supabaseProjectUrl()).toBe('')
  })

  it('accepts the build-time name, since the URL is already public', () => {
    process.env.VITE_SUPABASE_URL = PROJECT
    expect(supabaseProjectUrl()).toBe(PROJECT)
  })

  it('lets the unprefixed name override the build-time one', () => {
    process.env.SUPABASE_URL = 'https://server.supabase.co'
    process.env.VITE_SUPABASE_URL = 'https://bundle.supabase.co'
    expect(supabaseProjectUrl()).toBe('https://server.supabase.co')
  })

  it('strips a trailing slash, which would break `iss` and every REST path', () => {
    process.env.SUPABASE_URL = `${PROJECT}///`
    expect(supabaseProjectUrl()).toBe(PROJECT)
  })

  it('ignores surrounding whitespace from a pasted value', () => {
    process.env.SUPABASE_URL = `  ${PROJECT}  `
    expect(supabaseProjectUrl()).toBe(PROJECT)
  })
})

/**
 * The regression this module was extracted for.
 *
 * `googleConnections` accepted `VITE_SUPABASE_URL` and `auth` did not, so a site
 * configured that way reported itself ready to keep Drive connected, sent the
 * user through Google's consent screen, and then answered 503 to the one request
 * that would have stored the result. Nothing in either module's own tests could
 * see it: each was correct on its own terms.
 */
describe('the two halves that read it', () => {
  it('agree that a build-time-only deployment is configured', async () => {
    process.env.VITE_SUPABASE_URL = PROJECT
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    expect(storeConfig()).toEqual({ url: PROJECT, serviceKey: 'service-role-key' })

    // Not signed in, so this must fail — but as 401 "sign in", never 503 "this
    // site is not set up". Which of the two comes back is the whole bug.
    const session = await requireSession(new Request('https://x.test/api/google/connect'))
    expect(session.ok).toBe(false)
    if (session.ok) return
    expect(session.response.status).toBe(401)
  })

  it('agree that a deployment with no project at all is not configured', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    expect(storeConfig()).toBeNull()

    const session = await requireSession(new Request('https://x.test/api/google/connect'))
    expect(session.ok).toBe(false)
    if (session.ok) return
    expect(session.response.status).toBe(503)
  })
})
