/**
 * Getting a drafted report onto the project's issue tracker.
 *
 * The browser holds no GitHub credential — the token belongs to the deployment
 * and lives in the function environment, exactly like the fal key. So this is a
 * small client for /api/github and nothing more; what it is allowed to file, and
 * how often, is decided in netlify/lib/github.ts.
 *
 * Two calls, and the first one matters more than it looks. `loadIssueSupport`
 * asks whether the deployment can file at all, and the chat asks it before it
 * offers to: an assistant that walks someone through writing a careful bug
 * report and then discovers there is nowhere to send it has wasted the one
 * person in a hundred who was willing to write one.
 */
import { auth0Token } from '../auth0/client'
import { isMockEnabled } from '../mock'

export interface IssueSupport {
  /** Whether a report can actually be filed from here. */
  configured: boolean
  /** Where reports go, as `owner/repo`, when the deployment says. */
  repo: string | null
  /** True where the whole thing is pretend and nothing will be posted. */
  mocked: boolean
}

export interface FiledIssue {
  number: number | null
  url: string | null
}

const UNAVAILABLE: IssueSupport = { configured: false, repo: null, mocked: false }

export async function loadIssueSupport(): Promise<IssueSupport> {
  // Mock mode has no functions behind it at all — it is `vite dev` with the
  // providers faked — so the answer is "yes, and it is pretend". The report
  // flow is worth exercising offline; posting is what gets stubbed, loudly.
  if (isMockEnabled()) return { configured: true, repo: null, mocked: true }

  try {
    const response = await fetch('/api/github/status')
    if (!response.ok) return UNAVAILABLE

    const body = (await response.json()) as Partial<IssueSupport>
    return {
      configured: body.configured === true,
      repo: typeof body.repo === 'string' ? body.repo : null,
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
 * Only ever called from a button the user pressed on a draft they have seen.
 * Nothing in the chat path reaches this.
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
 * cannot triage without. It is shown in the draft before anything is posted —
 * appending details someone has not seen to something published under their
 * words is not a thing to do quietly.
 *
 * Nothing identifying: no account, no email, no project name, no prompt text.
 * A user agent and a screen size are what every web server already logs.
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
