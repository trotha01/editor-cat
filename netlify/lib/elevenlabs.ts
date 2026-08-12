/**
 * What a caller may do with *this deployment's* ElevenLabs key.
 *
 * The key used to be the visitor's own, which made the proxy in front of it a
 * plain pass-through: anything it forwarded was spent by the person who sent it,
 * on their own account. A site key changes every part of that. The endpoint now
 * spends the operator's money, reaches the operator's voice library, and is
 * reachable by anybody the deployment lets in — so it stops being a pass-through
 * and becomes a list of the things this app actually does.
 *
 * Three rules, and each one exists because of a specific thing that goes wrong
 * without it:
 *
 *  - **An allowlist**, because `api.elevenlabs.io` is a whole API. Left open, a
 *    signed-in visitor could read the account's subscription and history, or
 *    empty its voice library, through an endpoint this app never calls.
 *  - **A name check before a voice is deleted**, because the app does delete
 *    voices — its own throwaway clones — and the id in that request comes from
 *    the browser. Without the check, "delete the clone I just made" is also
 *    "delete any voice the operator has ever saved".
 *  - **A sweep for abandoned clones**, because every fix creates one and a
 *    browser closed mid-run leaves it behind. Voice slots are finite and
 *    per-account, so without this the feature quietly stops working for
 *    everybody, weeks later, for a reason nobody will connect to it.
 *
 * All pure, so each rule is asserted directly rather than inferred from what the
 * proxy happened to forward.
 */

/**
 * The prefix on every voice this app creates for itself.
 *
 * The client builds these names in `src/lib/clipAudioFix.ts` (`cloneNameFor`);
 * this end recognises them. Two copies of one string, in two directories that
 * cannot import each other — `netlify/lib/elevenlabs.test.ts` checks they still
 * agree, because the day they stop is the day deleting a clone starts being
 * refused as somebody else's voice.
 */
export const CLONE_NAME_PREFIX = 'editor-cat fix'

/** Whether a voice is one of this app's throwaway clones. */
export function isAppClone(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(CLONE_NAME_PREFIX)
}

/**
 * How long a clone is assumed to still be in use.
 *
 * A clone lives between two requests seconds apart, so ten minutes is a very
 * long time to be one; anything older has been abandoned. It is deliberately not
 * shorter: the sweep runs while other people may be mid-fix, and deleting a
 * voice somebody is about to speak with would turn one person's tidy-up into
 * another person's failure.
 */
export const CLONE_MAX_AGE_MS = 10 * 60 * 1000

export interface UpstreamVoice {
  voice_id?: string
  name?: string
  /** Seconds since the epoch, as ElevenLabs reports it. */
  created_at_unix?: number
}

/**
 * Abandoned clones, oldest first.
 *
 * A voice with no creation time is left alone rather than assumed old. The field
 * is the only thing separating "nobody will miss this" from "somebody is using
 * it right now", and a sweep that guesses is worse than a sweep that does
 * nothing — the operator can always delete voices by hand, and cannot undelete
 * one.
 */
export function staleClones(
  voices: readonly UpstreamVoice[],
  nowMs: number,
  maxAgeMs = CLONE_MAX_AGE_MS,
): string[] {
  return voices
    .filter(
      (voice): voice is UpstreamVoice & { voice_id: string; created_at_unix: number } =>
        Boolean(voice.voice_id) &&
        isAppClone(voice.name) &&
        typeof voice.created_at_unix === 'number' &&
        Number.isFinite(voice.created_at_unix) &&
        nowMs - voice.created_at_unix * 1000 > maxAgeMs,
    )
    .sort((a, b) => a.created_at_unix - b.created_at_unix)
    .map((voice) => voice.voice_id)
}

/** The paths that create a voice, which are the ones a full library refuses. */
const CLONE_PATHS = new Set(['v1/voices/ivc/create', 'v1/voices/add'])

export function isCloneRequest(method: string, path: string): boolean {
  return method === 'POST' && CLONE_PATHS.has(path)
}

export function isVoiceDeletion(method: string, path: string): boolean {
  return method === 'DELETE' && /^v1\/voices\/[^/]+$/.test(path)
}

/**
 * Everything this app asks ElevenLabs for, and nothing else.
 *
 * Notably absent: `v1/user`, which is the account's own plan and usage. It is
 * reachable with a *caller's* key, where it is their account and their business
 * — that is what the "test connection" button in Settings reads — but the site's
 * subscription is not something a visitor needs to see.
 */
export function isAllowedWithSiteKey(method: string, path: string): boolean {
  if (method === 'GET') return path === 'v1/voices' || path === 'v1/models'
  if (method === 'POST') {
    return (
      isCloneRequest(method, path) ||
      // With or without the timestamps suffix: the editor asks for timings so it
      // can move the captions onto the speech, and the plain form is what a
      // future caller here would reach for first.
      /^v1\/text-to-speech\/[^/]+(\/with-timestamps)?$/.test(path) ||
      /^v1\/speech-to-speech\/[^/]+$/.test(path)
    )
  }
  return isVoiceDeletion(method, path)
}

/**
 * Whether a refused clone was refused for want of a voice slot.
 *
 * Matched on the message because that is what the API gives: the status is a
 * plain 400 or 403, shared with every other reason a clone can be rejected, and
 * sweeping the library in response to "that audio is too quiet" would be
 * destroying things over an unrelated failure.
 */
export function isVoiceLimitError(body: string): boolean {
  return /voice[_ ]?limit|max(imum)?[_ ]voices|too many voices/i.test(body)
}
