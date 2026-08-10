import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_BODY,
  MAX_TITLE,
  RATE_LIMIT,
  issueBody,
  issueTitle,
  labelsFor,
  neutraliseReferences,
  parseDraft,
  repoTarget,
  resetRateLimit,
  truncate,
  withinRateLimit,
  type IssueDraft,
} from './github'

/**
 * What stands between "someone typed something into a chat bubble" and "a
 * public issue exists under the operator's name".
 */

const DRAFT = {
  kind: 'bug',
  title: 'Captions drift after a cut',
  body: 'They drift by a second.',
} satisfies IssueDraft

describe('parseDraft', () => {
  it('accepts a complete draft', () => {
    const result = parseDraft(DRAFT)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.draft.kind).toBe('bug')
  })

  it('rejects a kind it does not know', () => {
    // Otherwise the label list would be indexed with it, and an unknown kind
    // would land as an undefined label on a real issue.
    const result = parseDraft({ ...DRAFT, kind: 'urgent' })
    expect(result.ok).toBe(false)
  })

  it.each([
    ['a missing title', { ...DRAFT, title: '   ' }],
    ['a missing body', { ...DRAFT, body: '' }],
    ['a non-object payload', 'file this please'],
    ['an array', [DRAFT]],
  ])('rejects %s', (_label, payload) => {
    expect(parseDraft(payload).ok).toBe(false)
  })

  it('truncates rather than refusing an over-long report', () => {
    // Losing five minutes of someone's writing to a limit nobody showed them is
    // worse than filing a report that says it was cut short.
    const result = parseDraft({ ...DRAFT, body: 'word '.repeat(4000) })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.draft.body.length).toBeLessThanOrEqual(MAX_BODY + 1)
  })

  it('drops an empty context rather than carrying a blank block', () => {
    const result = parseDraft({ ...DRAFT, context: '  ' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.draft.context).toBeUndefined()
  })
})

describe('truncate', () => {
  it('leaves anything within the limit alone', () => {
    expect(truncate('short', 20)).toBe('short')
  })

  it('marks what it cut', () => {
    expect(truncate('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…`)
  })

  it('prefers a nearby word boundary', () => {
    expect(truncate('the quick brown fox jumps', 22)).toBe('the quick brown fox…')
  })
})

describe('neutraliseReferences', () => {
  it('stops a mention from notifying anyone', () => {
    const out = neutraliseReferences('cc @octocat')
    expect(out).not.toContain('@octocat')
    expect(out.replace(/\u200B/g, '')).toBe('cc @octocat')
  })

  it('stops an issue number from cross-linking', () => {
    const out = neutraliseReferences('same as #412')
    expect(out).not.toContain('#412')
  })

  it('leaves an ordinary hash and at-sign alone', () => {
    // `#fff` is a colour and `me @ home` is prose; neither linkifies, and
    // sprinkling invisible characters through them would be pure vandalism.
    expect(neutraliseReferences('#fff and me @ home')).toBe('#fff and me @ home')
  })
})

describe('issueTitle', () => {
  it('says what kind of report it is', () => {
    expect(issueTitle({ ...DRAFT, kind: 'feature' })).toMatch(/^Feature request: /)
  })

  it('stays a summary even with a prefix on it', () => {
    const long = issueTitle({ ...DRAFT, kind: 'bug', title: 'x'.repeat(400) })
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE + 21)
  })
})

describe('issueBody', () => {
  it('leads with the reporter’s own words', () => {
    expect(issueBody(DRAFT)).toMatch(/^They drift by a second\./)
  })

  it('fences the collected context', () => {
    const body = issueBody({ ...DRAFT, context: 'Build: abc1234' })
    expect(body).toContain('```\nBuild: abc1234\n```')
  })

  it('cannot be broken out of the fence', () => {
    const body = issueBody({ ...DRAFT, context: '```\n<img src=x>' })
    expect(body.split('```').length).toBe(3)
  })

  it('says where it came from', () => {
    expect(issueBody(DRAFT)).toContain('in-app assistant')
  })
})

describe('labelsFor', () => {
  it('maps a feature request onto GitHub’s own default label', () => {
    expect(labelsFor('feature')).toEqual(['enhancement', 'from-app'])
  })

  it('marks every kind as coming from the app', () => {
    for (const kind of ['bug', 'feature', 'question'] as const) {
      expect(labelsFor(kind)).toContain('from-app')
    }
  })
})

describe('repoTarget', () => {
  it('splits owner and repo', () => {
    expect(repoTarget('trotha01/editor-cat')).toEqual({ owner: 'trotha01', repo: 'editor-cat' })
  })

  it.each([
    '',
    'editor-cat',
    'trotha01/editor-cat/issues',
    // This value is interpolated into the API path, so a slash or a dot segment
    // in either half would be a way to aim the request somewhere else entirely.
    '../../orgs/anthropic',
    'https://github.com/trotha01/editor-cat',
  ])('refuses %j', (value) => {
    expect(repoTarget(value)).toBeNull()
  })
})

describe('withinRateLimit', () => {
  beforeEach(resetRateLimit)

  it('allows a burst and then stops', () => {
    for (let i = 0; i < RATE_LIMIT.max; i += 1) {
      expect(withinRateLimit('auth0|abc')).toBe(true)
    }
    expect(withinRateLimit('auth0|abc')).toBe(false)
  })

  it('counts per account', () => {
    for (let i = 0; i < RATE_LIMIT.max; i += 1) withinRateLimit('auth0|abc')
    expect(withinRateLimit('auth0|xyz')).toBe(true)
  })

  it('forgets filings once the window has passed', () => {
    const start = 1_000_000
    for (let i = 0; i < RATE_LIMIT.max; i += 1) withinRateLimit('auth0|abc', start)
    expect(withinRateLimit('auth0|abc', start)).toBe(false)
    expect(withinRateLimit('auth0|abc', start + RATE_LIMIT.windowMs + 1)).toBe(true)
  })
})
