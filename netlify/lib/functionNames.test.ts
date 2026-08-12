import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Netlify turns *every* file in the functions directory into a deployable
 * function, and rejects the whole deploy if any resulting name contains
 * anything but letters, numbers, hyphens and underscores.
 *
 * That is easy to trip over by accident: dropping `_shared.test.ts` next to the
 * handlers yields a function called "_shared.test", and the site fails to
 * deploy at the very last step with an error that does not mention tests at
 * all. Helpers and their tests belong in netlify/lib/ instead.
 */
const FUNCTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'functions')

const VALID_NAME = /^[A-Za-z0-9_-]+$/

describe('netlify/functions directory', () => {
  const entries = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })

  it('contains only files whose function name Netlify will accept', () => {
    const offenders = entries
      .map((entry) => entry.name.replace(/\.(ts|js|mjs|cjs|tsx)$/, ''))
      .filter((name) => !VALID_NAME.test(name))

    expect(
      offenders,
      `These would deploy as functions with illegal names. Move helpers and ` +
        `tests to netlify/lib/ instead: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('holds nothing but the request handlers', () => {
    // A test or helper here is not just badly named — it also ships as a live
    // endpoint, which is not something to do by accident.
    const names = entries.map((entry) => entry.name).sort()
    // `session.ts` was here until Supabase started trusting Auth0 directly. It
    // minted the Supabase session the browser used to carry; with nothing to
    // mint, keeping it would deploy an endpoint whose only remaining effect
    // would be to hand out a credential nothing accepts.
    expect(names).toEqual([
      'anthropic.ts',
      'elevenlabs.ts',
      'fal.ts',
      'github.ts',
      'google.ts',
      'media.ts',
    ])
  })
})
