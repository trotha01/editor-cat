/**
 * Filing what someone tells the in-app assistant as a GitHub issue.
 *
 * The handler that uses this is netlify/functions/github.ts; everything worth
 * testing lives here, because Netlify turns every file in the functions
 * directory into a deployable endpoint (see functionNames.test.ts).
 *
 * Three things shape this module, and all three are about the same fact: the
 * issue tracker is public and the token belongs to the deployment, so anything
 * that reaches here is written to a public place under the operator's name.
 *
 *  - Nothing anonymous. The handler demands the same verified session the fal
 *    proxy does. An open endpoint that writes to a public tracker is a spam
 *    button with the operator's name on it.
 *  - Nothing unbounded. Titles and bodies are capped here rather than trusted
 *    to a UI that a determined caller can simply not use.
 *  - Nothing that notifies anyone. Reported text is stripped of `@mentions` and
 *    `#123` references before it is posted, so a report cannot be used to ping a
 *    person or spray cross-links across unrelated issues. See
 *    {@link neutraliseReferences}.
 */

export const ISSUE_KINDS = ['bug', 'feature', 'question'] as const

export type IssueKind = (typeof ISSUE_KINDS)[number]

/** Long enough for a real one-line summary, short enough to stay a summary. */
export const MAX_TITLE = 140

/** Room for steps to reproduce and a stack trace, and not much more. */
export const MAX_BODY = 6000

/** The browser/build block the app collects. Fixed shape, so this is generous. */
export const MAX_CONTEXT = 1500

export interface IssueDraft {
  kind: IssueKind
  title: string
  body: string
  /** Build and browser details the app collected, shown to the user first. */
  context?: string
}

export type ParseResult = { ok: true; draft: IssueDraft } | { ok: false; reason: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validates whatever the browser posted into an {@link IssueDraft}.
 *
 * Over-long fields are truncated rather than refused. The alternative is
 * rejecting a report someone has just spent five minutes writing because it ran
 * over a limit no one showed them, which loses the report — and the point of the
 * cap is to bound what gets written to the tracker, which truncation does.
 */
export function parseDraft(payload: unknown): ParseResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'Expected a JSON object.' }
  }

  const record = payload as Record<string, unknown>
  const kind = text(record.kind).toLowerCase()
  const title = text(record.title)
  const body = text(record.body)
  const context = text(record.context)

  if (!ISSUE_KINDS.includes(kind as IssueKind)) {
    return { ok: false, reason: `"kind" must be one of: ${ISSUE_KINDS.join(', ')}.` }
  }
  if (!title) return { ok: false, reason: 'A title is required.' }
  if (!body) return { ok: false, reason: 'A description is required.' }

  return {
    ok: true,
    draft: {
      kind: kind as IssueKind,
      title: truncate(title, MAX_TITLE),
      body: truncate(body, MAX_BODY),
      ...(context ? { context: truncate(context, MAX_CONTEXT) } : {}),
    },
  }
}

/** Cuts to length on a word boundary where one is nearby, and says it was cut. */
export function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value

  const hard = value.slice(0, limit)
  const lastSpace = hard.lastIndexOf(' ')
  // `lastIndexOf` answers -1 for a run with no spaces in it at all — a base64
  // data URL, a stack frame — where cutting "just before the last space" would
  // quietly drop the final character instead.
  const nearEnd = lastSpace > 0 && lastSpace > limit - 40
  return `${(nearEnd ? hard.slice(0, lastSpace) : hard).trimEnd()}…`
}

/**
 * Stops reported text from notifying anybody.
 *
 * GitHub turns `@name` into a mention and `#123` into a cross-reference
 * wherever they appear in an issue body, which makes a public "report a bug"
 * button a way to send notifications to strangers and to graffiti unrelated
 * issues. A zero-width space after the sigil is the usual answer: it is
 * invisible to a reader, survives copy-paste of the surrounding words, and is
 * enough to stop the linkifier.
 *
 * Deliberately not done by escaping into a code span, which would swallow the
 * formatting of anyone writing a legitimate `@` (an email address, a CSS
 * at-rule) and would read worse than the text they wrote.
 */
export function neutraliseReferences(value: string): string {
  // Written as an escape rather than pasted in: an invisible character in
  // source is unreviewable, and gets "tidied" away by the next person.
  const zwsp = '\u200B'
  return value.replace(/@(?=[\w-])/g, `@${zwsp}`).replace(/#(?=\d)/g, `#${zwsp}`)
}

const KIND_LABELS: Record<IssueKind, string> = {
  bug: 'bug',
  feature: 'enhancement',
  question: 'question',
}

/**
 * `bug` and `enhancement` and `question` are GitHub's own defaults, so they
 * exist in a repository nobody has curated. `from-app` is the one that has to be
 * created, and issue creation creates a missing label rather than failing.
 */
export function labelsFor(kind: IssueKind): string[] {
  return [KIND_LABELS[kind], 'from-app']
}

const KIND_PREFIX: Record<IssueKind, string> = {
  bug: 'Bug',
  feature: 'Feature request',
  question: 'Question',
}

/**
 * Prefixed with what kind of thing it is, because labels are invisible in a
 * notification email and in most list views, and "the editor lost my captions"
 * reads very differently depending on whether it is a report or a request.
 */
export function issueTitle(draft: IssueDraft): string {
  return truncate(`${KIND_PREFIX[draft.kind]}: ${draft.title}`, MAX_TITLE + 20)
}

/** Backticks in the collected context would break out of the fence below. */
function fenceable(value: string): string {
  return value.replace(/`/g, "'")
}

/**
 * The issue as it will be read by whoever triages it.
 *
 * The reporter's own words come first and unaltered (bar the reference
 * neutralising), because that is the part with the information in it. The
 * collected build and browser details go in a fenced block — which is both how
 * you want to read a user agent string and a second guarantee that nothing in
 * there renders as a link, a mention or an image.
 *
 * The footer is not decoration. An issue that arrives through a button in a web
 * app was written by someone who cannot be replied to in the thread unless they
 * come back to it, and a maintainer who does not know that will wait for an
 * answer that is not coming.
 */
export function issueBody(draft: IssueDraft): string {
  const parts = [neutraliseReferences(draft.body)]

  if (draft.context) {
    parts.push(['<!-- collected by the app -->', '```', fenceable(draft.context), '```'].join('\n'))
  }

  parts.push(
    '---\n' +
      '_Filed from the in-app assistant in editor-cat. The reporter may not be ' +
      'watching this thread — there is no notification back into the app._',
  )

  return parts.join('\n\n')
}

export interface RepoTarget {
  owner: string
  repo: string
}

/**
 * Which repository issues are filed against, from `GITHUB_REPO`.
 *
 * A single `owner/repo` string rather than two variables: it is what a person
 * would copy out of the address bar, and two variables where one is set is a
 * misconfiguration that only shows up when somebody tries to file something.
 *
 * The character class is GitHub's own rule for both halves, and it matters here
 * beyond tidiness — this value is interpolated into the API path, so anything
 * looser would be a way to point the request at another endpoint entirely.
 */
export function repoTarget(value = process.env.GITHUB_REPO ?? ''): RepoTarget | null {
  const match = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/.exec(value.trim())
  if (!match) return null

  const [, owner, repo] = match
  // `.` and `..` satisfy the character class and would resolve the API path
  // somewhere else. GitHub has no such repository either, so nothing is lost.
  if ([owner, repo].some((part) => part === '.' || part === '..')) return null

  return { owner: owner!, repo: repo! }
}

/**
 * A best-effort brake on how fast one account can file.
 *
 * Deliberately modest, and deliberately in memory. Functions scale out, so this
 * is per instance and a determined caller with a valid session could get more
 * through than the number below suggests — it is here to stop a stuck retry loop
 * or an impatient person from filling the tracker, not to stand in for the
 * session check, which is what actually keeps strangers out.
 *
 * Real durable limiting would need a store this app does not otherwise need on
 * the server side, and adding one for this would be a poor trade.
 */
const WINDOW_MS = 10 * 60 * 1000
const MAX_PER_WINDOW = 5

const filings = new Map<string, number[]>()

export function withinRateLimit(userId: string, now = Date.now()): boolean {
  const recent = (filings.get(userId) ?? []).filter((at) => now - at < WINDOW_MS)

  if (recent.length >= MAX_PER_WINDOW) {
    filings.set(userId, recent)
    return false
  }

  recent.push(now)
  filings.set(userId, recent)

  // Unbounded growth would otherwise outlive every instance: entries are only
  // ever added, and one per signed-in visitor adds up on a warm function.
  if (filings.size > 5000) {
    for (const [key, times] of filings) {
      if (times.every((at) => now - at >= WINDOW_MS)) filings.delete(key)
    }
  }

  return true
}

/** Exported for tests, which must not inherit another test's filings. */
export function resetRateLimit(): void {
  filings.clear()
}

export const RATE_LIMIT = { windowMs: WINDOW_MS, max: MAX_PER_WINDOW } as const
