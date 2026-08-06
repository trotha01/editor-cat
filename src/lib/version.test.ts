import { afterEach, describe, expect, it } from 'vitest'
import { BUILD, installVersionGlobal } from './version'

/**
 * The version marker exists to answer one question under pressure: is the site
 * running the code I think it is? A marker that is absent, stale or shaped
 * differently than expected answers nothing, and the moment you need it is the
 * moment you cannot easily test it.
 */
afterEach(() => {
  delete (window as { VERSION?: unknown }).VERSION
})

describe('BUILD', () => {
  it('is substituted at build time rather than read at runtime', () => {
    // If Vite's `define` ever stops matching, this is a bare identifier that
    // throws a ReferenceError — which is exactly the failure worth catching
    // here rather than in a browser console on a deployed site.
    expect(BUILD).toBeTypeOf('object')
  })

  it('carries everything needed to identify a deploy', () => {
    // The branch matters as much as the commit: a branch deploy running old code
    // is the case this was built for, and a hash alone does not show it.
    expect(BUILD).toMatchObject({
      commit: expect.any(String),
      short: expect.any(String),
      branch: expect.any(String),
      context: expect.any(String),
      builtAt: expect.any(String),
    })
  })

  it('abbreviates the commit consistently with the full one', () => {
    if (BUILD.commit === 'unknown') {
      expect(BUILD.short).toBe('unknown')
      return
    }
    expect(BUILD.short).toBe(BUILD.commit.slice(0, 7))
    expect(BUILD.short).toHaveLength(7)
  })
})

describe('installVersionGlobal', () => {
  it('makes VERSION answer as a bare identifier in the console', () => {
    expect(window.VERSION).toBeUndefined()

    installVersionGlobal()

    expect(window.VERSION).toEqual(BUILD)
  })
})
