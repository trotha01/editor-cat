import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The routing and refusals in `netlify/functions/github.ts`.
 *
 * Lives here rather than beside the handler because Netlify turns every file in
 * the functions directory into a deployable endpoint — see functionNames.test.ts.
 *
 * Session verification is covered by auth.test.ts and the composition of the
 * issue itself by github.test.ts, so the first is mocked and the second is left
 * real. What only exists in the handler is the part worth pinning down: that
 * nothing anonymous can file, that a deployment which has not been set up says
 * so rather than failing at GitHub, and that GitHub's own words about a token
 * never reach the browser.
 */
const requireSession = vi.fn()

vi.mock('./auth', () => ({
  requireSession: (request: Request) => requireSession(request) as unknown,
}))

const { RATE_LIMIT, resetRateLimit } = await import('./github')
const handler = (await import('../functions/github')).default

const ISSUE = {
  kind: 'bug',
  title: 'Captions drift after a cut',
  body: 'They drift by about a second. cc @octocat',
  context: 'Build: abc1234 (production)',
}

function post(route: string, payload: unknown = ISSUE): Request {
  return new Request(`https://site.example/api/github/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

function get(route: string, token?: string): Request {
  return new Request(`https://site.example/api/github/${route}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

/** What GitHub answers when it has created one. */
function created(): Response {
  return new Response(
    JSON.stringify({ number: 412, html_url: 'https://github.com/owner/repo/issues/412' }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  )
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimit()
  process.env.GITHUB_TOKEN = 'ghp_test'
  process.env.GITHUB_REPO = 'owner/repo'
  requireSession.mockResolvedValue({
    ok: true,
    userId: 'auth0|42',
    email: 'someone@example.com',
  })
  // A fresh Response per call: a body can only be read once, so a shared one
  // fails every request after the first for a reason that has nothing to do
  // with what is being tested.
  fetchMock.mockImplementation(() => Promise.resolve(created()))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.GITHUB_TOKEN
  delete process.env.GITHUB_REPO
})

describe('status', () => {
  it('says the feature is available, and where reports go', async () => {
    const response = await handler(get('status'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      configured: true,
      repo: 'owner/repo',
    })
  })

  it('answers without a session, because the form asks before offering to file', async () => {
    const response = await handler(get('status'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ reporter: null })
    // Asking who somebody is when they have not said is a round trip for an
    // answer nobody can use.
    expect(requireSession).not.toHaveBeenCalled()
  })

  it('tells a signed-in caller which address a report of theirs would carry', async () => {
    // The form shows this before anything is posted. It has to be the value the
    // *server* will attach, or the preview is a guess about someone's own email
    // on a public issue.
    await expect((await handler(get('status', 'auth0-token'))).json()).resolves.toMatchObject({
      reporter: 'someone@example.com',
    })
  })

  it('says nothing about a caller whose token does not hold up', async () => {
    // And does not fail: a signed-out browser asking whether reporting works
    // must be told that it does, not that something is broken.
    requireSession.mockResolvedValue({ ok: false, response: new Response('no', { status: 401 }) })

    const response = await handler(get('status', 'stale-token'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ configured: true, reporter: null })
  })

  it('reports a deployment with no token as simply unavailable', async () => {
    delete process.env.GITHUB_TOKEN

    // Not an error: a checkout without a token is a perfectly good editor that
    // cannot file issues, and the form says so rather than taking a report
    // someone has just written to nowhere.
    await expect((await handler(get('status'))).json()).resolves.toEqual({
      configured: false,
      repo: null,
      reporter: null,
    })
  })

  it('reports a malformed GITHUB_REPO as unavailable too', async () => {
    process.env.GITHUB_REPO = 'https://github.com/owner/repo'

    await expect((await handler(get('status'))).json()).resolves.toMatchObject({
      configured: false,
    })
  })
})

describe('filing', () => {
  it('creates the issue and hands back where it landed', async () => {
    const response = await handler(post('issues'))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      number: 412,
      url: 'https://github.com/owner/repo/issues/412',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/owner/repo/issues')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ghp_test')
  })

  it('sends a title, a body and labels GitHub already has', async () => {
    await handler(post('issues'))

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.title).toBe('Bug: Captions drift after a cut')
    expect(body.labels).toEqual(['bug', 'from-app'])
    expect(body.body).toContain('Build: abc1234 (production)')
    // Composition is github.test.ts's job; that it is applied at all is this
    // handler's, and posting a raw body would notify a stranger.
    expect(body.body).not.toContain('@octocat')
  })

  it('attributes the issue to the session, not to the request body', async () => {
    await handler(post('issues', { ...ISSUE, reporter: 'ceo@example.com' }))

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.body).toContain('someone@example.com')
    // Anyone with an account could otherwise file under somebody else's name,
    // publicly, in a line that reads as though this site checked it.
    expect(body.body).not.toContain('ceo@example.com')
  })

  it('still files for a tenant that puts no address in its tokens', async () => {
    requireSession.mockResolvedValue({ ok: true, userId: 'auth0|42', email: null })

    expect((await handler(post('issues'))).status).toBe(201)

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.body).toContain('auth0|42')
  })

  it('refuses a caller with no session', async () => {
    const refusal = { ok: false, response: new Response('no', { status: 401 }) }
    requireSession.mockResolvedValue(refusal)

    expect((await handler(post('issues'))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to file before it verifies anything else', async () => {
    // Order matters: a 400 for a malformed body would tell an anonymous caller
    // that this endpoint exists and what shape it wants.
    requireSession.mockResolvedValue({ ok: false, response: new Response('no', { status: 401 }) })

    expect((await handler(post('issues', 'not json'))).status).toBe(401)
  })

  it('names the missing variable to the operator, not to the visitor', async () => {
    delete process.env.GITHUB_REPO

    const response = await handler(post('issues'))

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an incomplete report before spending a request on it', async () => {
    const response = await handler(post('issues', { kind: 'bug', title: 'x' }))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body that is not JSON at all', async () => {
    expect((await handler(post('issues', 'help me'))).status).toBe(400)
  })

  it('stops one account from filling the tracker', async () => {
    for (let i = 0; i < RATE_LIMIT.max; i += 1) {
      expect((await handler(post('issues'))).status).toBe(201)
    }

    const response = await handler(post('issues'))
    expect(response.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(RATE_LIMIT.max)
  })

  it('keeps GitHub’s words about the token out of the browser', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: 'Resource not accessible by personal access token' }),
        {
          status: 403,
        },
      ),
    )

    const response = await handler(post('issues'))
    const body = (await response.json()) as { error: string; detail: string }

    // A rejected token is the operator's problem, so it reads as "this site",
    // not as something the reporter typed wrong.
    expect(response.status).toBe(503)
    expect(JSON.stringify(body)).not.toContain('personal access token')
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('403')
  })

  it('reports GitHub being down as GitHub being down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    expect((await handler(post('issues'))).status).toBe(502)
  })
})

describe('routing', () => {
  it('has nothing to say to any other path', async () => {
    expect((await handler(get('repos'))).status).toBe(404)
  })

  it('will not file over GET, which no link should be able to do', async () => {
    expect((await handler(get('issues'))).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
