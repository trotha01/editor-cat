import { describe, expect, it } from 'vitest'
import { isAllowedWithSiteKey, isAppJob, isDubDeletion } from './elevenlabs'

/**
 * The rules that stand between a signed-in visitor and the operator's own
 * ElevenLabs account. Each of them is the whole of a defence, so each is
 * asserted here rather than through the proxy that applies them.
 */

describe('isAllowedWithSiteKey', () => {
  it('allows exactly what the editor calls', () => {
    expect(isAllowedWithSiteKey('GET', 'v1/voices')).toBe(true)
    expect(isAllowedWithSiteKey('GET', 'v1/models')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/speech-to-speech/abc123')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/forced-alignment')).toBe(true)
  })

  it('allows the whole of one fix, start to finish', () => {
    // Every call a run makes, in the order it makes them. Written out as the
    // sequence rather than as a set because a single missing entry does not
    // fail the feature until whichever step needed it, which on this path can
    // be minutes and a paid render in.
    const run: [string, string][] = [
      ['POST', 'v1/dubbing'],
      ['GET', 'v1/dubbing/dub_1'],
      ['GET', 'v1/dubbing/resource/dub_1'],
      ['PATCH', 'v1/dubbing/resource/dub_1/speaker/sp_1'],
      ['PATCH', 'v1/dubbing/resource/dub_1/segment/seg_1/es'],
      ['POST', 'v1/dubbing/resource/dub_1/speaker/sp_1/segment'],
      ['DELETE', 'v1/dubbing/resource/dub_1/segment/seg_9'],
      ['POST', 'v1/dubbing/resource/dub_1/dub'],
      ['POST', 'v1/dubbing/resource/dub_1/render/es'],
      ['GET', 'v1/dubbing/dub_1/audio/es'],
      ['DELETE', 'v1/dubbing/dub_1'],
    ]
    for (const [method, path] of run) {
      expect([method, path, isAllowedWithSiteKey(method, path)]).toEqual([method, path, true])
    }
  })

  it('will not list the account’s dubbing projects', () => {
    // The one that matters most on this surface, and it is one character of
    // regex away from the call above it. Nothing here can be enumerated, which
    // is what lets the segment and resource calls go unguarded: an id you were
    // not given is an id you cannot reach.
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing')).toBe(false)
  })

  it('keeps the account’s own plan and history out of reach', () => {
    // Reachable with a caller's own key, where it is their account. The site's
    // subscription, usage and history are nobody's business but the operator's.
    expect(isAllowedWithSiteKey('GET', 'v1/user')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/user/subscription')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/history')).toBe(false)
    expect(isAllowedWithSiteKey('DELETE', 'v1/history/xyz')).toBe(false)
  })

  it('no longer forwards the calls the text-to-speech fix used to make', () => {
    // Nothing speaks a line or copies a voice through this proxy any more, and
    // an allowlist that still permitted it would be a standing invitation to
    // spend the site's credits on an endpoint the app has stopped calling.
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc123')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc123/with-timestamps')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/voices/add')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/voices/ivc/create')).toBe(false)
    expect(isAllowedWithSiteKey('DELETE', 'v1/voices/abc123')).toBe(false)
  })

  it('refuses anything that only looks like an allowed call', () => {
    expect(isAllowedWithSiteKey('GET', 'v1/voices/abc123')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/voices')).toBe(false)
    expect(isAllowedWithSiteKey('PUT', 'v1/dubbing/dub_1')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing/dub_1/transcript/es')).toBe(false)
    // Translating is the one dubbing call this feature must never make: the
    // captions are the script, so a translation is the provider replacing the
    // user's words with its own.
    expect(isAllowedWithSiteKey('POST', 'v1/dubbing/resource/dub_1/translate')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/dubbing/resource/dub_1/transcribe')).toBe(false)
    expect(isAllowedWithSiteKey('DELETE', 'v1/dubbing/resource/dub_1')).toBe(false)
  })
})

describe('isDubDeletion', () => {
  it('recognises a deletion of one job, and nothing else', () => {
    expect(isDubDeletion('DELETE', 'v1/dubbing/dub_1')).toBe(true)
    expect(isDubDeletion('DELETE', 'v1/dubbing')).toBe(false)
    expect(isDubDeletion('POST', 'v1/dubbing/dub_1')).toBe(false)
    // Deleting a segment is not deleting the job, and must not be sent through
    // the name check — it addresses something inside a job, not the job.
    expect(isDubDeletion('DELETE', 'v1/dubbing/resource/dub_1/segment/seg_1')).toBe(false)
  })
})

describe('isAppJob', () => {
  it('recognises the names this app gives its own dubbing jobs', () => {
    // The client end of this string is checked against these rules in
    // `src/lib/clipAudioFix.test.ts`, which can import both sides — the
    // functions build cannot see `src`, and dragging the browser's half into it
    // would drag `import.meta.env` in with it.
    expect(isAppJob('editor-cat fix · lighthouse.mp4')).toBe(true)
    expect(isAppJob('editor-cat fix · ' + 'a'.repeat(300))).toBe(true)
  })

  it('does not claim a job the operator made by hand', () => {
    // A Dubbing Studio project somebody has been editing all afternoon, which
    // is what the name check exists to keep out of reach of a delete request
    // carrying an id from the browser.
    expect(isAppJob('Spanish cut v3')).toBe(false)
    expect(isAppJob('my editor-cat fix job')).toBe(false)
    expect(isAppJob(undefined)).toBe(false)
    expect(isAppJob(42)).toBe(false)
  })
})
