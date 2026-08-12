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
      ['POST', 'v1/dubbing/project'],
      ['GET', 'v1/dubbing/project/proj_1'],
      ['GET', 'v1/dubbing/project/proj_1/transcript'],
      ['PATCH', 'v1/dubbing/project/proj_1/transcript/segments'],
      ['POST', 'v1/dubbing/project/proj_1/transcript/segment'],
      ['DELETE', 'v1/dubbing/project/proj_1/transcript/segment/seg_9'],
      ['POST', 'v1/dubbing/project/proj_1/language'],
      ['GET', 'v1/dubbing/project/proj_1/language/lang_1'],
      ['DELETE', 'v1/dubbing/project/proj_1'],
    ]
    for (const [method, path] of run) {
      expect([method, path, isAllowedWithSiteKey(method, path)]).toEqual([method, path, true])
    }
  })

  it('will not list the account’s dubbing projects', () => {
    // The one that matters most on this surface, and it is one path element
    // away from the call above it. Nothing here can be enumerated, which is
    // what lets the project and segment calls go unguarded: an id you were not
    // given is an id you cannot reach.
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing/project')).toBe(false)
    // The older dubbing API, which this app no longer speaks at all.
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/dubbing')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing/resource/dub_1')).toBe(false)
  })

  it('does not forward the finished audio, because it does not travel this way', () => {
    // The dub arrives as a signed, time-limited URL on another origin and is
    // fetched straight from the browser. Nothing here needs to carry it, so
    // nothing here does.
    expect(isAllowedWithSiteKey('GET', 'v1/dubbing/project/proj_1/language/lang_1/audio')).toBe(
      false,
    )
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
    expect(isAllowedWithSiteKey('PUT', 'v1/dubbing/project/proj_1')).toBe(false)
    // A target's transcript carries the machine translation of every segment.
    // The captions are the script, so a translation is the provider replacing
    // the user's words with its own, and this app never reads or writes one.
    expect(
      isAllowedWithSiteKey('GET', 'v1/dubbing/project/proj_1/language/lang_1/transcript'),
    ).toBe(false)
    expect(
      isAllowedWithSiteKey(
        'PATCH',
        'v1/dubbing/project/proj_1/language/lang_1/transcript/segments',
      ),
    ).toBe(false)
    expect(
      isAllowedWithSiteKey(
        'POST',
        'v1/dubbing/project/proj_1/language/lang_1/transcript/regenerate',
      ),
    ).toBe(false)
    // The per-segment rewrite: real, but not something this app calls, because
    // the segments go together as one script.
    expect(
      isAllowedWithSiteKey('PATCH', 'v1/dubbing/project/proj_1/transcript/segment/seg_1'),
    ).toBe(false)
  })
})

describe('isDubDeletion', () => {
  it('recognises a deletion of one project, and nothing else', () => {
    expect(isDubDeletion('DELETE', 'v1/dubbing/project/proj_1')).toBe(true)
    expect(isDubDeletion('DELETE', 'v1/dubbing/project')).toBe(false)
    expect(isDubDeletion('POST', 'v1/dubbing/project/proj_1')).toBe(false)
    // Deleting a segment is not deleting the project, and must not be sent
    // through the reference check — it addresses something inside a project.
    expect(isDubDeletion('DELETE', 'v1/dubbing/project/proj_1/transcript/segment/seg_1')).toBe(
      false,
    )
  })
})

describe('isAppJob', () => {
  it('recognises the references this app gives its own dubbing projects', () => {
    // The client end of this string is checked against these rules in
    // `src/lib/clipAudioFix.test.ts`, which can import both sides — the
    // functions build cannot see `src`, and dragging the browser's half into it
    // would drag `import.meta.env` in with it.
    expect(isAppJob('editor-cat fix · lighthouse.mp4')).toBe(true)
    expect(isAppJob('editor-cat fix · ' + 'a'.repeat(300))).toBe(true)
  })

  it('does not claim a project the operator made by hand', () => {
    // A dubbing project somebody has been editing all afternoon, which is what
    // the reference check exists to keep out of reach of a delete request
    // carrying an id from the browser.
    expect(isAppJob('Spanish cut v3')).toBe(false)
    expect(isAppJob('my editor-cat fix job')).toBe(false)
    expect(isAppJob(undefined)).toBe(false)
    expect(isAppJob(42)).toBe(false)
  })
})
