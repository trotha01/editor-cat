import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The browser's half of filing a report.
 *
 * Three things are worth holding down. A deployment that cannot file must say
 * so *before* anyone is invited to write a report, however it fails to answer —
 * including the checkout where /api does not exist at all. A failure at the end
 * must come back as a sentence rather than a status code, because it lands on
 * someone who has just written the thing. And the address shown in the form has
 * to be the one the server derived from the session, not one this side made up:
 * it is what the public issue will carry.
 */
const mocked = { enabled: false }

vi.mock('../mock', () => ({
  isMockEnabled: () => mocked.enabled,
}))

vi.mock('../auth0/client', () => ({
  auth0Token: () => Promise.resolve('auth0-token'),
}))

const { fileIssue, loadIssueSupport, supportContext } = await import('./issues')

const BUILD = { short: 'abc1234', branch: 'main', context: 'production' }

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mocked.enabled = false
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('loadIssueSupport', () => {
  it('reports a deployment that can file, where to, and as whom', async () => {
    fetchMock.mockResolvedValue(
      json({ configured: true, repo: 'owner/repo', reporter: 'someone@example.com' }),
    )

    await expect(loadIssueSupport()).resolves.toEqual({
      configured: true,
      repo: 'owner/repo',
      reporter: 'someone@example.com',
      mocked: false,
    })
  })

  it('asks as the signed-in user, since the answer is about them', async () => {
    fetchMock.mockResolvedValue(json({ configured: true, repo: 'owner/repo' }))

    await loadIssueSupport()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/github/status')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer auth0-token')
  })

  it('copes with a deployment whose tokens carry no address', async () => {
    // The tenant has to add a claim for this to be answerable; without it the
    // form says an account id will go on the issue instead of an address.
    fetchMock.mockResolvedValue(json({ configured: true, repo: 'owner/repo', reporter: '' }))

    await expect(loadIssueSupport()).resolves.toMatchObject({ reporter: null })
  })

  it('reports a deployment that cannot', async () => {
    fetchMock.mockResolvedValue(json({ configured: false, repo: null }))

    await expect(loadIssueSupport()).resolves.toMatchObject({ configured: false })
  })

  it('treats a checkout with no /api routes as simply unable to file', async () => {
    // `vite dev` serves no functions, so this throws rather than answering 404.
    // It is not an error to show anyone — the bubble just stops offering.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(loadIssueSupport()).resolves.toEqual(UNAVAILABLE)
  })

  it('treats an error page as unable to file', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 500 }))

    await expect(loadIssueSupport()).resolves.toEqual(UNAVAILABLE)
  })

  it('says so where the whole thing is pretend', async () => {
    mocked.enabled = true

    await expect(loadIssueSupport()).resolves.toMatchObject({ configured: true, mocked: true })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

const UNAVAILABLE = { configured: false, repo: null, reporter: null, mocked: false }

describe('fileIssue', () => {
  const REPORT = { kind: 'bug', title: 'Captions drift', body: 'By a second.' }

  it('posts the report and hands back where it landed', async () => {
    fetchMock.mockResolvedValue(
      json({ number: 412, url: 'https://github.com/o/r/issues/412' }, 201),
    )

    await expect(fileIssue(REPORT)).resolves.toEqual({
      number: 412,
      url: 'https://github.com/o/r/issues/412',
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/github/issues')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer auth0-token')
  })

  it('turns a lapsed session into the thing to do about it', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Sign in to generate.' }, 401))

    await expect(fileIssue(REPORT)).rejects.toThrow(/sign in again/i)
  })

  it('passes on what the server said about a refusal', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'That is a lot of reports in a short time.', detail: 'Up to 5.' }, 429),
    )

    await expect(fileIssue(REPORT)).rejects.toThrow(/a lot of reports in a short time\. Up to 5\./)
  })

  it('still says something when the failure answers in HTML', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }))

    await expect(fileIssue(REPORT)).rejects.toThrow(/could not be filed/i)
  })

  it('posts nothing at all in mock mode', async () => {
    mocked.enabled = true

    await expect(fileIssue(REPORT)).resolves.toEqual({ number: null, url: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('supportContext', () => {
  it('collects what a reporter cannot be expected to know', () => {
    const context = supportContext(BUILD)

    expect(context).toContain('Build: abc1234 (main, production)')
    expect(context).toContain('Browser:')
  })

  it('does not collect the address itself', () => {
    // The reporter's address goes on the issue, but it is attached by the
    // function from the verified session — never assembled here, where it would
    // be whatever the browser felt like claiming.
    const context = supportContext(BUILD).toLowerCase()

    expect(context).not.toContain('@')
    expect(context).not.toContain('token')
  })
})
