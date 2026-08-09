import { describe, expect, it } from 'vitest'
import {
  badgeBuild,
  buildAge,
  formatAge,
  isStale,
  prUrl,
  STAGING,
  STALE_AFTER_MS,
  type StagingBuild,
} from './stagingBuild'

/**
 * The badge is a debugging aid that appears on exactly one deployed site, which
 * makes it a thing nobody can check by looking. Two failures matter and only one
 * of them is visible: a badge that does not appear is an annoyance, and a badge
 * that appears somewhere it should not — or names a build that is not the one on
 * screen — is a lie told to whoever is trying to work out what is deployed.
 */

const build: StagingBuild = {
  pr: 412,
  title: 'Refresh the OAuth token before it expires',
  author: 'trotha01',
  branch: 'feat/oauth-refresh',
  sha: 'a1b3c9d',
  repo: 'trotha01/editor-cat',
  builtAt: '2026-08-09T12:00:00.000Z',
  host: 'staging--editor-cat.netlify.app',
}

const builtAt = Date.parse(build.builtAt)
const MINUTE = 60_000

describe('STAGING', () => {
  it('is substituted at build time rather than read at runtime', () => {
    // A bare identifier if Vite's `define` ever stops matching, which throws
    // here instead of on a deployed site. Null is the correct value in a test
    // run, and in every build that is not a staging one.
    expect(STAGING).toBeNull()
  })
})

describe('badgeBuild', () => {
  it('draws nothing for a build that carries no staging information', () => {
    // Production. The file exists on one branch, so this is what every other
    // build inlines, and it is what keeps the badge off them.
    expect(badgeBuild('editor-cat.example', null)).toBeNull()
  })

  it('draws nothing on a host that is not the one built for', () => {
    // The staging bundle, served from somewhere that is not staging: a local
    // preview of the branch, or a copy promoted where it should not have been.
    expect(badgeBuild('localhost', build)).toBeNull()
    expect(badgeBuild('editor-cat.example', build)).toBeNull()
  })

  it('draws on the host the build was made for', () => {
    expect(badgeBuild('staging--editor-cat.netlify.app', build)).toBe(build)
  })

  it('compares hosts the way hosts compare, not the way strings do', () => {
    expect(badgeBuild('STAGING--Editor-Cat.netlify.app', build)).toBe(build)
  })

  it('draws nothing when the build could not name where it was going', () => {
    // Netlify's URL variables missing from the build environment. The check
    // cannot be answered, so it is failed rather than waved through — otherwise
    // an empty host would match an empty hostname and defeat the whole guard.
    expect(badgeBuild('', { ...build, host: '' })).toBeNull()
    expect(badgeBuild('staging--editor-cat.netlify.app', { ...build, host: '' })).toBeNull()
  })
})

describe('prUrl', () => {
  it('points at the pull request on GitHub', () => {
    expect(prUrl(build)).toBe('https://github.com/trotha01/editor-cat/pull/412')
  })

  it('has nowhere to point when main itself moved', () => {
    expect(prUrl({ ...build, pr: null })).toBeNull()
  })
})

describe('buildAge', () => {
  it('measures from when the mirror ran', () => {
    expect(buildAge(build, builtAt + 3 * MINUTE)).toBe(3 * MINUTE)
  })

  it('treats a clock that disagrees slightly as now, not as the future', () => {
    expect(buildAge(build, builtAt - 5000)).toBe(0)
  })

  it('admits to not knowing rather than reporting a nonsense age', () => {
    expect(buildAge({ ...build, builtAt: 'whenever' }, builtAt)).toBeNull()
  })
})

describe('isStale', () => {
  it('leaves a build from a few minutes ago alone', () => {
    expect(isStale(3 * MINUTE)).toBe(false)
  })

  it('holds off until the half hour is actually up', () => {
    expect(isStale(STALE_AFTER_MS - 1)).toBe(false)
    expect(isStale(STALE_AFTER_MS)).toBe(true)
  })

  it('counts an unknown age against the build', () => {
    // Not knowing how old something is is not the same as it being new, and the
    // colour is there to make someone look twice.
    expect(isStale(null)).toBe(true)
  })
})

describe('formatAge', () => {
  it('reads as an age rather than as a timestamp', () => {
    expect(formatAge(20_000)).toBe('just now')
    expect(formatAge(3 * MINUTE)).toBe('3m ago')
    expect(formatAge(59 * MINUTE)).toBe('59m ago')
    expect(formatAge(90 * MINUTE)).toBe('1h ago')
    expect(formatAge(50 * 60 * MINUTE)).toBe('2d ago')
  })

  it('says so when it cannot tell', () => {
    expect(formatAge(null)).toBe('age unknown')
  })
})
