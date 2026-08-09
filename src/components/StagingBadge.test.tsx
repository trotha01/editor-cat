import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { StagingBuild } from '../lib/stagingBuild'

/**
 * The badge on the one deployment that cannot identify itself.
 *
 * Two things are worth holding down here. It must not appear anywhere it has no
 * business appearing, because a build marker on the wrong page is worse than no
 * marker at all. And it must not become furniture — one line, click-through,
 * dismissable — because a permanent box in the corner of the editor is a price
 * paid on every deploy for something only wanted on some of them.
 */

const build: StagingBuild = {
  pr: 412,
  title: 'Refresh the OAuth token before it expires',
  author: 'trotha01',
  branch: 'feat/oauth-refresh',
  sha: 'a1b3c9d',
  repo: 'trotha01/editor-cat',
  builtAt: '2026-08-09T12:00:00.000Z',
  // jsdom serves these tests from localhost, so that is what stands in for the
  // staging host. The check being exercised is the real one either way: what the
  // build claims, against where the page actually is.
  host: 'localhost',
}

const BUILT_AT = Date.parse(build.builtAt)
const MINUTE = 60_000

const current: { build: StagingBuild | null } = { build: null }

vi.mock('../lib/stagingBuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stagingBuild')>()
  // Only the value Vite substitutes is stood in for; everything the component
  // then does with it, the host check included, is the shipped code.
  return {
    ...actual,
    get STAGING() {
      return current.build
    },
  }
})

const { StagingBadge } = await import('./StagingBadge')

beforeEach(() => {
  current.build = build
  window.sessionStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(BUILT_AT + 3 * MINUTE)
})

afterEach(() => {
  vi.useRealTimers()
})

function badge() {
  return screen.queryByRole('complementary', { name: 'Staging build' })
}

describe('where it appears', () => {
  it('draws nothing in a build that carries no staging information', () => {
    // Production, and every other build: the file the badge reads exists on one
    // branch only, so there is nothing here to draw from.
    current.build = null

    render(<StagingBadge />)

    expect(badge()).not.toBeInTheDocument()
  })

  it('draws nothing when the page is not the site the build was made for', () => {
    // The staging bundle served from somewhere that is not staging. The guard is
    // the address in the browser, not the flag in the bundle, so this stays true
    // however the bundle got here.
    current.build = { ...build, host: 'staging--editor-cat.netlify.app' }

    render(<StagingBadge />)

    expect(badge()).not.toBeInTheDocument()
  })

  it('draws on the staging site itself', () => {
    render(<StagingBadge />)

    expect(badge()).toBeInTheDocument()
  })

  it('lets clicks through to the editor behind it', () => {
    // The whole reason it can sit over the app at all: the frame it reserves
    // takes no clicks, and only the badge inside it does.
    render(<StagingBadge />)

    expect(badge()).toHaveClass('pointer-events-none')
    expect(badge()?.firstElementChild).toHaveClass('pointer-events-auto')
  })
})

describe('what it says', () => {
  it('names the PR, the branch, the commit and the age in one line', () => {
    render(<StagingBadge />)

    expect(badge()).toHaveTextContent('PR #412')
    expect(badge()).toHaveTextContent('feat/oauth-refresh')
    expect(badge()).toHaveTextContent('a1b3c9d')
    expect(badge()).toHaveTextContent('3m ago')
  })

  it('links the PR number to the PR, in a tab of its own', () => {
    render(<StagingBadge />)

    const link = screen.getByRole('link', { name: 'PR #412' })

    expect(link).toHaveAttribute('href', 'https://github.com/trotha01/editor-cat/pull/412')
    // Leaving this tab would throw away the editor state being checked.
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('keeps the title, the author and the build time behind a click', () => {
    render(<StagingBadge />)

    expect(badge()).not.toHaveTextContent(build.title)

    fireEvent.click(screen.getByTitle('Show build details'))

    expect(badge()).toHaveTextContent(build.title)
    expect(badge()).toHaveTextContent('@trotha01')
    expect(badge()).toHaveTextContent(new Date(build.builtAt).toLocaleString())
  })

  it('says main rather than inventing a PR when main itself moved', () => {
    current.build = { ...build, pr: null, title: '', author: '', branch: 'main' }

    render(<StagingBadge />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(badge()).toHaveTextContent('main')
  })
})

describe('how old it is', () => {
  it('ages while it is being looked at', () => {
    // The case this is for: the tab was open before the deploy landed, and
    // nobody reloads a page to find out whether it is stale.
    render(<StagingBadge />)
    expect(badge()).toHaveTextContent('3m ago')

    act(() => void vi.advanceTimersByTime(2 * MINUTE))

    expect(badge()).toHaveTextContent('5m ago')
  })

  it('turns to a warning once it is probably not your build any more', () => {
    render(<StagingBadge />)
    expect(screen.queryByRole('img', { name: 'Stale build' })).not.toBeInTheDocument()

    act(() => void vi.advanceTimersByTime(30 * MINUTE))

    // The colour changes too, but the colour alone is not something everybody
    // can read — so the warning is in the content as well.
    expect(screen.getByRole('img', { name: 'Stale build' })).toBeInTheDocument()
    expect(badge()).toHaveTextContent('33m ago')
  })
})

describe('sending it away', () => {
  it('goes when told to', () => {
    render(<StagingBadge />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide the staging badge' }))

    expect(badge()).not.toBeInTheDocument()
  })

  it('stays gone for the tab, and no longer', () => {
    const first = render(<StagingBadge />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide the staging badge' }))
    first.unmount()

    render(<StagingBadge />)
    expect(badge()).not.toBeInTheDocument()

    // A new tab is a new session, and gets the badge back: the alternative is a
    // marker that one stray click disables for good on the site it exists for.
    window.sessionStorage.clear()
    render(<StagingBadge />)
    expect(badge()).toBeInTheDocument()
  })
})
