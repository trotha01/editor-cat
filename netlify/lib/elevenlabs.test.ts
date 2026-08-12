import { describe, expect, it } from 'vitest'
import {
  CLONE_MAX_AGE_MS,
  isAllowedWithSiteKey,
  isAppClone,
  isCloneRequest,
  isVoiceDeletion,
  isVoiceLimitError,
  staleClones,
} from './elevenlabs'

/**
 * The rules that stand between a signed-in visitor and the operator's own
 * ElevenLabs account. Each of them is the whole of a defence, so each is
 * asserted here rather than through the proxy that applies them.
 */

describe('isAllowedWithSiteKey', () => {
  it('allows exactly what the editor calls', () => {
    expect(isAllowedWithSiteKey('GET', 'v1/voices')).toBe(true)
    expect(isAllowedWithSiteKey('GET', 'v1/models')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc123')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc123/with-timestamps')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/speech-to-speech/abc123')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/voices/ivc/create')).toBe(true)
    expect(isAllowedWithSiteKey('POST', 'v1/voices/add')).toBe(true)
    expect(isAllowedWithSiteKey('DELETE', 'v1/voices/abc123')).toBe(true)
  })

  it('keeps the account’s own plan and history out of reach', () => {
    // Reachable with a caller's own key, where it is their account. The site's
    // subscription, usage and history are nobody's business but the operator's.
    expect(isAllowedWithSiteKey('GET', 'v1/user')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/user/subscription')).toBe(false)
    expect(isAllowedWithSiteKey('GET', 'v1/history')).toBe(false)
    expect(isAllowedWithSiteKey('DELETE', 'v1/history/xyz')).toBe(false)
  })

  it('refuses anything that only looks like an allowed call', () => {
    expect(isAllowedWithSiteKey('GET', 'v1/voices/abc123')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/voices')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc/stream')).toBe(false)
    expect(isAllowedWithSiteKey('POST', 'v1/text-to-speech/abc/with-timestamps/stream')).toBe(false)
    expect(isAllowedWithSiteKey('PUT', 'v1/voices/abc123')).toBe(false)
    expect(isAllowedWithSiteKey('DELETE', 'v1/voices/abc123/settings')).toBe(false)
  })
})

describe('isCloneRequest and isVoiceDeletion', () => {
  it('names the two paths that make a voice', () => {
    expect(isCloneRequest('POST', 'v1/voices/ivc/create')).toBe(true)
    expect(isCloneRequest('POST', 'v1/voices/add')).toBe(true)
    expect(isCloneRequest('POST', 'v1/text-to-speech/abc')).toBe(false)
    expect(isCloneRequest('GET', 'v1/voices/add')).toBe(false)
  })

  it('recognises a deletion of one voice, and nothing else', () => {
    expect(isVoiceDeletion('DELETE', 'v1/voices/abc123')).toBe(true)
    expect(isVoiceDeletion('DELETE', 'v1/voices')).toBe(false)
    expect(isVoiceDeletion('POST', 'v1/voices/abc123')).toBe(false)
  })
})

describe('isAppClone', () => {
  it('recognises the names this app gives its own clones', () => {
    // The client end of this string is checked against these rules in
    // `src/lib/clipAudioFix.test.ts`, which can import both sides — the
    // functions build cannot see `src`, and dragging the browser's half into it
    // would drag `import.meta.env` in with it.
    expect(isAppClone('editor-cat fix · lighthouse.mp4')).toBe(true)
    expect(isAppClone('editor-cat fix · ' + 'a'.repeat(300))).toBe(true)
  })

  it('does not claim a voice the operator saved', () => {
    expect(isAppClone('Rachel')).toBe(false)
    expect(isAppClone('my editor-cat fix voice')).toBe(false)
    expect(isAppClone(undefined)).toBe(false)
    expect(isAppClone(42)).toBe(false)
  })
})

describe('staleClones', () => {
  const now = 1_800_000_000_000
  const agoSeconds = (ms: number) => (now - ms) / 1000

  it('takes the app’s abandoned clones, oldest first', () => {
    const ids = staleClones(
      [
        {
          voice_id: 'old',
          name: 'editor-cat fix · a.mp4',
          created_at_unix: agoSeconds(60 * 60_000),
        },
        {
          voice_id: 'older',
          name: 'editor-cat fix · b.mp4',
          created_at_unix: agoSeconds(90 * 60_000),
        },
      ],
      now,
    )
    expect(ids).toEqual(['older', 'old'])
  })

  it('leaves a clone that could still be halfway through a fix', () => {
    const ids = staleClones(
      [{ voice_id: 'fresh', name: 'editor-cat fix · a.mp4', created_at_unix: agoSeconds(30_000) }],
      now,
    )
    expect(ids).toEqual([])
  })

  it('never touches a voice this app did not make, however old', () => {
    const ids = staleClones(
      [{ voice_id: 'theirs', name: 'Narrator', created_at_unix: agoSeconds(400 * 60_000) }],
      now,
    )
    expect(ids).toEqual([])
  })

  it('leaves a voice with no creation time alone rather than guessing', () => {
    // The field is the only thing separating "nobody will miss this" from
    // "somebody is speaking with it right now".
    expect(staleClones([{ voice_id: 'x', name: 'editor-cat fix · a.mp4' }], now)).toEqual([])
  })

  it('cuts at the age it says it does', () => {
    const justUnder = agoSeconds(CLONE_MAX_AGE_MS - 1000)
    const justOver = agoSeconds(CLONE_MAX_AGE_MS + 1000)
    const voices = [
      { voice_id: 'under', name: 'editor-cat fix · a', created_at_unix: justUnder },
      { voice_id: 'over', name: 'editor-cat fix · b', created_at_unix: justOver },
    ]
    expect(staleClones(voices, now)).toEqual(['over'])
  })
})

describe('isVoiceLimitError', () => {
  it('recognises a library with no room left', () => {
    expect(isVoiceLimitError('{"detail":{"status":"voice_limit_reached"}}')).toBe(true)
    expect(isVoiceLimitError('You have reached your maximum voices.')).toBe(true)
    expect(isVoiceLimitError('too many voices in this account')).toBe(true)
  })

  it('does not sweep the library over an unrelated refusal', () => {
    // Everything else a clone can be refused for shares the same status code, so
    // this is what stands between "that sample was too short" and deleting
    // voices in response to it.
    expect(isVoiceLimitError('{"detail":{"status":"invalid_api_key"}}')).toBe(false)
    expect(isVoiceLimitError('The audio you provided is too short.')).toBe(false)
    expect(isVoiceLimitError('')).toBe(false)
  })
})
