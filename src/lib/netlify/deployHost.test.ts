import { describe, expect, it } from 'vitest'
import { relocatedUrl } from './deployHost'

const DOMAIN = 'staging.simka.cat'

describe('relocatedUrl', () => {
  it('moves a deploy preview onto the domain the site owns', () => {
    expect(relocatedUrl('https://deploy-preview-32--editor-cat.netlify.app/', DOMAIN)).toBe(
      'https://deploy-preview-32.staging.simka.cat/',
    )
  })

  it('moves a branch deploy the same way', () => {
    expect(relocatedUrl('https://some-branch--editor-cat.netlify.app/', DOMAIN)).toBe(
      'https://some-branch.staging.simka.cat/',
    )
  })

  it('carries the fragment across, because the fragment is the sign-in', () => {
    // Netlify Identity returns its tokens in the hash. Dropping it here would
    // relocate the visitor and sign them out in the same move.
    const moved = relocatedUrl(
      'https://deploy-preview-32--editor-cat.netlify.app/#access_token=abc&refresh_token=def',
      DOMAIN,
    )

    expect(moved).toBe(
      'https://deploy-preview-32.staging.simka.cat/#access_token=abc&refresh_token=def',
    )
  })

  it('keeps the path and query, so a deep link survives the move', () => {
    expect(
      relocatedUrl('https://deploy-preview-32--editor-cat.netlify.app/oauth/google?code=c', DOMAIN),
    ).toBe('https://deploy-preview-32.staging.simka.cat/oauth/google?code=c')
  })

  it('splits at the last separator, so a branch name may contain one', () => {
    // A site name cannot contain `--`; a slugified branch name can. So the
    // rightmost one is always the boundary between the two.
    expect(relocatedUrl('https://feat--wip--editor-cat.netlify.app/', DOMAIN)).toBe(
      'https://feat--wip.staging.simka.cat/',
    )
  })

  it('leaves the site’s own netlify.app address alone', () => {
    // No `--` means this is the site, not a deploy of it, and there is no
    // subdomain form of it to move to.
    expect(relocatedUrl('https://editor-cat.netlify.app/', DOMAIN)).toBeNull()
  })

  it('does nothing once the visitor is already on the deploy domain', () => {
    // Which is what stops this bouncing forever: the result of a move is never
    // itself a netlify.app address.
    expect(relocatedUrl('https://deploy-preview-32.staging.simka.cat/', DOMAIN)).toBeNull()
  })

  it('does nothing at all with no deploy domain configured', () => {
    // The ordinary case: a site whose deploys share one URL, and `netlify dev`.
    expect(relocatedUrl('https://deploy-preview-32--editor-cat.netlify.app/', null)).toBeNull()
  })

  it('ignores hosts that are not Netlify’s, and addresses that are not URLs', () => {
    expect(relocatedUrl('https://example.com/', DOMAIN)).toBeNull()
    expect(relocatedUrl('http://localhost:8888/', DOMAIN)).toBeNull()
    expect(relocatedUrl('not a url', DOMAIN)).toBeNull()
  })

  it('ignores a host whose separator leaves no deploy name in front of it', () => {
    expect(relocatedUrl('https://--editor-cat.netlify.app/', DOMAIN)).toBeNull()
  })
})
