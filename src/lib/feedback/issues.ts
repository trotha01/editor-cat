/**
 * Getting a written report onto the project's issue tracker.
 *
 * The browser holds no GitHub credential — the token belongs to the deployment
 * and lives in the function environment, exactly like the fal key. So this is a
 * small client for /api/github and nothing more; what it is allowed to file, and
 * how often, is decided in netlify/lib/github.ts.
 *
 * Two calls, and the first one matters more than it looks. `loadIssueSupport`
 * asks whether the deployment can file at all *and* which address it would
 * attach, both before the form is drawn. Asking early is what lets the form
 * either work or not appear, rather than collecting a careful report and then
 * discovering there was nowhere to send it — and what lets it show the person
 * their own address in the preview instead of a promise about one.
 */
import { auth0Token } from '../auth0/client'
import { isMockEnabled } from '../mock'

export interface IssueSupport {
  /** Whether a report can actually be filed from here. */
  configured: boolean
  /** Where reports go, as `owner/repo`, when the deployment says. */
  repo: string | null
  /**
   * The address a report from this browser would be filed under, as the server
   * derived it from the session — not as the browser would like it to read.
   * Null where the tenant puts no address in its access tokens, in which case
   * the account id goes on the issue instead.
   */
  reporter: string | null
  /** True where the whole thing is pretend and nothing will be posted. */
  mocked: boolean
}

export interface FiledIssue {
  number: number | null
  url: string | null
}

const UNAVAILABLE: IssueSupport = {
  configured: false,
  repo: null,
  reporter: null,
  mocked: false,
}

export async function loadIssueSupport(): Promise<IssueSupport> {
  // Mock mode has no functions behind it at all — it is `vite dev` with the
  // providers faked — so the answer is "yes, and it is pretend". The report
  // flow is worth exercising offline; posting is what gets stubbed, loudly.
  // The address is invented and says so, because a preview with nothing where
  // the address goes would not exercise the part that matters.
  if (isMockEnabled()) {
    return { configured: true, repo: null, reporter: 'you@example.com (mock)', mocked: true }
  }

  try {
    // Carries the session so the answer can include *this* caller's address.
    // Absent on a checkout with no Auth0 tenant, where the endpoint answers the
    // configured/repo half and says nothing about anybody.
    const token = await auth0Token()
    const response = await fetch('/api/github/status', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) return UNAVAILABLE

    const body = (await response.json()) as Partial<IssueSupport>
    return {
      configured: body.configured === true,
      repo: typeof body.repo === 'string' ? body.repo : null,
      reporter: typeof body.reporter === 'string' && body.reporter ? body.reporter : null,
      mocked: false,
    }
  } catch {
    // A checkout served by plain `vite dev` has no /api routes, so this throws
    // rather than 404s. Either way the answer is the same and it is not an
    // error worth showing anyone: the bubble simply does not offer to file.
    return UNAVAILABLE
  }
}

export interface FileIssueInput {
  kind: string
  title: string
  body: string
  /** Build and browser details, already shown to the user. */
  context?: string
}

/**
 * Files a report, and throws with something readable if it cannot.
 *
 * Deliberately carries no identity of its own. Who filed it is decided from the
 * token by the function on the other end — see `Reporter` in
 * netlify/lib/github.ts — so nothing here, and nothing anyone types into the
 * form, can put another person's address on a public issue.
 */
export async function fileIssue(input: FileIssueInput): Promise<FiledIssue> {
  if (isMockEnabled()) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return { number: null, url: null }
  }

  const token = await auth0Token()

  const response = await fetch('/api/github/issues', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Absent on a checkout with no Auth0 tenant, where the function is
      // expected to be running with anonymous access allowed — the same
      // arrangement the fal proxy has.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  })

  if (!response.ok) throw new Error(await failureMessage(response))

  return (await response.json()) as FiledIssue
}

async function failureMessage(response: Response): Promise<string> {
  let body: { error?: unknown; detail?: unknown } = {}
  try {
    body = (await response.json()) as typeof body
  } catch {
    // Some failures are not ours and answer in HTML.
  }

  const error = typeof body.error === 'string' ? body.error : 'That report could not be filed.'
  const detail = typeof body.detail === 'string' && body.detail ? ` ${body.detail}` : ''

  if (response.status === 401) {
    return 'Sign in again, then post this report.'
  }
  return `${error}${detail}`
}

/**
 * The build and browser details that go on the end of a report.
 *
 * Collected rather than asked for, because "which browser, which version, which
 * build of the site" is the part a reporter cannot answer and a maintainer
 * cannot triage without. All of it is shown in the form before anything is
 * posted — appending details someone has not seen to something published under
 * their own words is not a thing to do quietly, and that goes double now that
 * the address is among them.
 *
 * The address itself is not collected here. It is added by the function from
 * the verified session, and shown in the preview from `IssueSupport.reporter`,
 * which is the same value the server will use.
 */
export function supportContext(build: { short: string; branch: string; context: string }): string {
  const lines = [
    `Build: ${build.short} (${build.branch}, ${build.context})`,
    `Page: ${location.origin}`,
  ]

  if (typeof navigator !== 'undefined') {
    lines.push(`Browser: ${navigator.userAgent}`)
    if (navigator.language) lines.push(`Language: ${navigator.language}`)
  }

  if (typeof window !== 'undefined' && window.screen) {
    lines.push(`Window: ${window.innerWidth}×${window.innerHeight}`)
    lines.push(`Screen: ${window.screen.width}×${window.screen.height}`)
  }

  return lines.join('\n')
}

/** The project's own shape, which is most of what a timeline bug depends on. */
export function projectContext(summary: {
  clips: number
  durationSeconds: number
  audioClips: number
  captions: number
  orientation: string
}): string {
  return [
    `Project: ${summary.clips} clips, ${summary.durationSeconds.toFixed(1)}s, ${summary.orientation}`,
    `Audio clips: ${summary.audioClips}`,
    `Captions: ${summary.captions}`,
  ].join('\n')
}

/**
 * The shelf's shape, which is what a word-pages bug depends on instead.
 *
 * A report from that page used to carry the project block, which was a report
 * about a timeline nobody had opened: all zeroes, and no hint of the tree the
 * bug was actually in. How big the shelf is and whether Drive is connected are
 * the two things that separate "this is broken" from "this is slow with four
 * hundred words" and from "this never reached Drive at all".
 */
export function shelfContext(summary: {
  tiers: number
  languages: number
  words: number
  videosOnOpenWord: number
  driveConnected: boolean
}): string {
  return [
    `Shelf: ${summary.tiers} tiers, ${summary.languages} languages, ${summary.words} words`,
    `Open word: ${summary.videosOnOpenWord} videos`,
    `Drive: ${summary.driveConnected ? 'connected' : 'not connected'}`,
  ].join('\n')
}
