/**
 * Which pull request the staging site is showing.
 *
 * `staging` is a mirror: main, plus every open PR merged on top, rebuilt from
 * scratch whenever any of them moves (see .github/workflows/staging.yml). It
 * deploys to one fixed URL, because that URL is registered with Google and a
 * per-PR address could not sign anyone in — and one URL is what makes the
 * deploy unable to introduce itself. Netlify's `BRANCH`, `COMMIT_REF` and
 * `CONTEXT` all describe the mirror, so `VERSION` there says `staging` and a
 * merge commit written by a bot, which answers nothing anyone was asking.
 *
 * So the workflow writes down what it knows while it still knows it, and this
 * reads it back. What it names is the pull request whose event caused the
 * rebuild — not the only one in the build, since every open PR is in there.
 * That is the useful question all the same: what is on the screen was either put
 * there by your push, or by somebody else's, and you are still waiting.
 *
 * Nothing here is a secret. It is a branch name, a commit and a PR number, all
 * of them already public on a repository this is only ever built from.
 */
export interface StagingBuild {
  /** The pull request this rebuild was for, or null when main itself moved. */
  pr: number | null
  /** The pull request's title. Empty where there is no pull request. */
  title: string
  /** The author's GitHub login. Empty where there is no pull request. */
  author: string
  /** The branch the work is on: the PR's head, or `main`. */
  branch: string
  /** Short SHA of that branch's tip — the one to hold your own HEAD against. */
  sha: string
  /** `owner/name`, which is all that is missing to link to the PR. */
  repo: string
  /** When the mirror ran, ISO 8601. */
  builtAt: string
  /**
   * The host this bundle was built to be served from, as Netlify named it at
   * build time. A claim, checked in the browser by {@link badgeBuild}.
   */
  host: string
}

/**
 * The staging build behind this bundle, or null — which is the normal answer.
 *
 * Substituted by Vite from `staging-build.json`, a file that exists on the
 * staging branch and nowhere else, so production does not inline one.
 */
export const STAGING: StagingBuild | null = __STAGING__

/**
 * The build a badge may be drawn for on `hostname`, or null for no badge.
 *
 * Two things have to hold, and they fail in different directions. There has to
 * be something to say: only the staging branch carries the file, so every other
 * build has `null` here and can draw nothing whatever else is true of it. And
 * the page has to be the staging site — the same bundle served from anywhere
 * else is not staging, whatever it was built for, and a badge claiming
 * otherwise would be worse than no badge at all.
 *
 * The second check is against the address in the browser rather than anything
 * baked into the bundle, and it has to be: a build flag says what a build
 * intended, and `location.hostname` says where it actually ended up. A local
 * `vite preview` of the branch, a checkout someone is bisecting, a copy
 * promoted somewhere it should not have been — all of them carry the file, and
 * none of them is staging.
 */
export function badgeBuild(hostname: string, build: StagingBuild | null): StagingBuild | null {
  // No host recorded means the build could not name where it was going, and an
  // unanswerable check is failed rather than skipped.
  if (!build || !build.host) return null
  return hostname.toLowerCase() === build.host.toLowerCase() ? build : null
}

/** Where the pull request itself is, or null when this build is not one. */
export function prUrl(build: StagingBuild): string | null {
  if (build.pr === null || !build.repo) return null
  return `https://github.com/${build.repo}/pull/${build.pr}`
}

/**
 * How old the build is in milliseconds, or null where it will not say.
 *
 * Clamped at zero: the timestamp comes off a runner's clock and is read on
 * somebody's laptop, and a couple of seconds of disagreement between the two
 * should read as "just now" rather than as a build from the future.
 */
export function buildAge(build: StagingBuild, now: number): number | null {
  const at = Date.parse(build.builtAt)
  return Number.isNaN(at) ? null : Math.max(0, now - at)
}

/**
 * Past this, what is on screen is probably not the build you are waiting for.
 *
 * A rebuild and a deploy together take a few minutes, and a push to any open PR
 * starts another one. Half an hour is comfortably longer than that, so a build
 * older than it has almost certainly been superseded — or never happened,
 * because the mirror hit a conflict or the deploy failed. Either way the page is
 * not showing what its reader thinks it is, which is the one thing a marker like
 * this exists to prevent.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000

export function isStale(age: number | null): boolean {
  // An age nobody can work out is not evidence of freshness, so it counts as the
  // bad case rather than the good one.
  return age === null || age >= STALE_AFTER_MS
}

/** The age, short enough to sit on one line of badge. */
export function formatAge(age: number | null): string {
  if (age === null) return 'age unknown'

  const minutes = Math.floor(age / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}
