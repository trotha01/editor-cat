import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteConnection, readConnection, storeConfig, writeConnection } from './googleConnections'

const config = { url: 'https://project.supabase.co', serviceKey: 'service-role-key' }

function serve(status: number, body: unknown = []) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    // 204 forbids a body, which is what PostgREST answers a `return=minimal`
    // write with.
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name)
}

describe('storeConfig', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.VITE_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('needs both halves, since the anon key cannot read this table by design', () => {
    process.env.SUPABASE_URL = config.url
    expect(storeConfig()).toBeNull()

    process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceKey
    expect(storeConfig()).toEqual(config)
  })

  it('accepts the build-time project URL, since it is the same public string', () => {
    // Only the service key is a secret. Making an operator set the URL under two
    // names is how the two drift apart — and the failure when they do is a site
    // that refuses every sign-in without saying which half is missing.
    process.env.VITE_SUPABASE_URL = config.url
    process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceKey

    expect(storeConfig()).toEqual(config)
  })

  it('prefers the unprefixed name when both are set', () => {
    process.env.SUPABASE_URL = 'https://server.supabase.co'
    process.env.VITE_SUPABASE_URL = 'https://bundle.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceKey

    expect(storeConfig()?.url).toBe('https://server.supabase.co')
  })

  it('tolerates a trailing slash on a pasted project URL', () => {
    process.env.SUPABASE_URL = 'https://project.supabase.co/'
    process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceKey

    expect(storeConfig()?.url).toBe('https://project.supabase.co')
  })
})

describe('readConnection', () => {
  it('presents the service role, which is what bypasses the table’s locked-down RLS', async () => {
    const { impl, calls } = serve(200, [{ refresh_token: '1//refresh', scope: 'drive.file' }])

    await expect(readConnection('user_42', config, impl)).resolves.toEqual({
      refreshToken: '1//refresh',
      scope: 'drive.file',
    })

    expect(calls[0]?.url).toContain('/rest/v1/google_connections?user_id=eq.user_42')
    expect(headerOf(calls[0]!.init, 'authorization')).toBe(`Bearer ${config.serviceKey}`)
    expect(headerOf(calls[0]!.init, 'apikey')).toBe(config.serviceKey)
  })

  it('returns null for a user who has never connected', async () => {
    const { impl } = serve(200, [])
    await expect(readConnection('user_42', config, impl)).resolves.toBeNull()
  })

  it('raises rather than silently reporting "not connected" when the read fails', async () => {
    // The difference matters: a swallowed error here would show the Connect
    // button to someone who is already connected, and re-prompt them for consent.
    const { impl } = serve(500, { message: 'boom' })
    await expect(readConnection('user_42', config, impl)).rejects.toThrow(/Could not read/)
  })
})

describe('writeConnection', () => {
  it('upserts, so reconnecting replaces the token rather than adding a row', async () => {
    const { impl, calls } = serve(201)

    await writeConnection('user_42', { refreshToken: '1//new', scope: 'drive.file' }, config, impl)

    expect(calls[0]?.url).toContain('on_conflict=user_id')
    expect(headerOf(calls[0]!.init, 'prefer')).toContain('resolution=merge-duplicates')
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      user_id: 'user_42',
      refresh_token: '1//new',
      scope: 'drive.file',
    })
  })

  it('asks for no row back, so the refresh token cannot end up in a log', async () => {
    const { impl, calls } = serve(201)

    await writeConnection('user_42', { refreshToken: '1//new', scope: '' }, config, impl)

    expect(headerOf(calls[0]!.init, 'prefer')).toContain('return=minimal')
  })
})

describe('deleteConnection', () => {
  it('removes only the one user’s row', async () => {
    const { impl, calls } = serve(204)

    await deleteConnection('user_42', config, impl)

    expect(calls[0]?.init.method).toBe('DELETE')
    expect(calls[0]?.url).toContain('user_id=eq.user_42')
  })
})
