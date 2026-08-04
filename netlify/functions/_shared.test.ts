import { describe, expect, it } from 'vitest'
import {
  isAllowedMediaUrl,
  isBlockedHost,
  passthroughHeaders,
  redactHeaders,
  requireKey,
  upstreamPath,
} from './_shared'

describe('isBlockedHost', () => {
  it('blocks loopback and localhost', () => {
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('127.1.2.3')).toBe(true)
    expect(isBlockedHost('::1')).toBe(true)
  })

  it('blocks the cloud metadata address', () => {
    // The classic SSRF target: this endpoint hands out instance credentials.
    expect(isBlockedHost('169.254.169.254')).toBe(true)
  })

  it('blocks private and CGNAT ranges', () => {
    expect(isBlockedHost('10.0.0.5')).toBe(true)
    expect(isBlockedHost('172.16.0.1')).toBe(true)
    expect(isBlockedHost('172.31.255.255')).toBe(true)
    expect(isBlockedHost('192.168.1.1')).toBe(true)
    expect(isBlockedHost('100.64.0.1')).toBe(true)
    expect(isBlockedHost('fd00::1')).toBe(true)
    expect(isBlockedHost('fe80::1')).toBe(true)
  })

  it('allows public hosts and addresses just outside the private ranges', () => {
    expect(isBlockedHost('v3.fal.media')).toBe(false)
    expect(isBlockedHost('172.32.0.1')).toBe(false)
    expect(isBlockedHost('11.0.0.1')).toBe(false)
    expect(isBlockedHost('100.128.0.1')).toBe(false)
  })
})

describe('isAllowedMediaUrl', () => {
  it('accepts provider media hosts', () => {
    expect(isAllowedMediaUrl('https://v3.fal.media/files/abc.mp4').ok).toBe(true)
    expect(isAllowedMediaUrl('https://fal.media/x.png').ok).toBe(true)
    expect(isAllowedMediaUrl('https://api.elevenlabs.io/v1/x.mp3').ok).toBe(true)
  })

  it('refuses hosts that are not on the allowlist', () => {
    // Without this the endpoint is an open proxy for anyone on the internet.
    const result = isAllowedMediaUrl('https://example.com/evil.mp4')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/allowlist/i)
  })

  it('is not fooled by an allowlisted host appearing elsewhere in the URL', () => {
    expect(isAllowedMediaUrl('https://fal.media.evil.com/x.mp4').ok).toBe(false)
    expect(isAllowedMediaUrl('https://evil.com/?x=https://fal.media/a.mp4').ok).toBe(false)
    expect(isAllowedMediaUrl('https://evil.com#fal.media').ok).toBe(false)
  })

  it('refuses non-https schemes', () => {
    expect(isAllowedMediaUrl('http://fal.media/x.mp4').ok).toBe(false)
    expect(isAllowedMediaUrl('file:///etc/passwd').ok).toBe(false)
    expect(isAllowedMediaUrl('gopher://fal.media/').ok).toBe(false)
  })

  it('refuses malformed input', () => {
    expect(isAllowedMediaUrl('not a url').ok).toBe(false)
    expect(isAllowedMediaUrl('').ok).toBe(false)
  })
})

describe('requireKey', () => {
  it('accepts and trims a supplied key', () => {
    const request = new Request('https://x.test/api/fal/m', { headers: { 'x-fal-key': '  abc  ' } })
    const result = requireKey(request, 'x-fal-key', 'fal.ai')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.key).toBe('abc')
  })

  it('rejects a missing or blank key with a 401 and actionable text', () => {
    const missing = requireKey(new Request('https://x.test/'), 'x-fal-key', 'fal.ai')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.response.status).toBe(401)

    const blank = new Request('https://x.test/', { headers: { 'x-fal-key': '   ' } })
    expect(requireKey(blank, 'x-fal-key', 'fal.ai').ok).toBe(false)
  })
})

describe('upstreamPath', () => {
  it('strips the proxy mount point', () => {
    expect(upstreamPath('/api/fal/fal-ai/flux/dev', '/api/fal')).toBe('fal-ai/flux/dev')
    expect(upstreamPath('/api/elevenlabs/v1/voices', '/api/elevenlabs')).toBe('v1/voices')
  })

  it('returns an empty string when nothing follows the mount point', () => {
    expect(upstreamPath('/api/fal', '/api/fal')).toBe('')
    expect(upstreamPath('/api/fal/', '/api/fal')).toBe('')
  })
})

describe('redactHeaders', () => {
  it('never lets a credential reach a log line', () => {
    const headers = new Headers({
      authorization: 'Key secret-value',
      'xi-api-key': 'secret-value',
      'content-type': 'application/json',
    })
    const redacted = redactHeaders(headers)

    expect(redacted.authorization).toBe('[redacted]')
    expect(redacted['xi-api-key']).toBe('[redacted]')
    expect(redacted['content-type']).toBe('application/json')
    expect(JSON.stringify(redacted)).not.toContain('secret-value')
  })
})

describe('passthroughHeaders', () => {
  it('keeps the headers a media response needs', () => {
    const upstream = new Headers({
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': '1024',
    })
    const out = passthroughHeaders(upstream)
    expect(out.get('content-type')).toBe('video/mp4')
    expect(out.get('accept-ranges')).toBe('bytes')
  })

  it('drops upstream cookies so a provider cannot set state on our origin', () => {
    const upstream = new Headers({ 'set-cookie': 'session=abc', 'content-type': 'video/mp4' })
    expect(passthroughHeaders(upstream).get('set-cookie')).toBeNull()
  })
})
