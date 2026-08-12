/**
 * What a caller may do with *this deployment's* ElevenLabs key.
 *
 * The key used to be the visitor's own, which made the proxy in front of it a
 * plain pass-through: anything it forwarded was spent by the person who sent it,
 * on their own account. A site key changes every part of that. The endpoint now
 * spends the operator's money, reaches the operator's voice library and dubbing
 * projects, and is reachable by anybody the deployment lets in — so it stops
 * being a pass-through and becomes a list of the things this app actually does.
 *
 * Two rules, and each one exists because of a specific thing that goes wrong
 * without it:
 *
 *  - **An allowlist**, because `api.elevenlabs.io` is a whole API. Left open, a
 *    signed-in visitor could read the account's subscription and history, list
 *    every dubbing project the operator has ever made, or empty its voice
 *    library, through an endpoint this app never calls.
 *  - **A name check before a dubbing project is deleted**, because the app does
 *    delete them — its own, at the end of every fix — and the id in that request
 *    comes from the browser. Without the check, "delete the job I just made" is
 *    also "delete any dub the operator has ever made", and a dubbing project is
 *    hours of somebody's editing rather than a throwaway.
 *
 * What is deliberately *not* guarded is the rest of the dubbing surface: reading
 * a project, rewriting its segments, adding a language. Each of those names a
 * project id, and confirming ownership means a round trip to fetch its
 * reference — which on the polling paths would double the request count of
 * every run. The id is what protects them instead, and it holds here in a way it
 * would not for voices: `GET v1/dubbing/project` (the list) is **not** on the
 * allowlist, so there is no way through this proxy to learn an id that was not
 * yours. Voice ids, by
 * contrast, are listable by design — which is exactly why deleting one needed a
 * check and reading one did not.
 *
 * All pure, so each rule is asserted directly rather than inferred from what the
 * proxy happened to forward.
 */

/**
 * The prefix on every dubbing project this app creates for itself.
 *
 * The client builds these names in `src/lib/clipAudioFix.ts` (`dubNameFor`);
 * this end recognises them. Two copies of one string, in two directories that
 * cannot import each other — `netlify/lib/elevenlabs.test.ts` checks they still
 * agree, because the day they stop is the day deleting a finished job starts
 * being refused as somebody else's, and the account fills up with copies of
 * clips nobody can remove.
 */
export const APP_JOB_PREFIX = 'editor-cat fix'

/** Whether a dubbing project is one of this app's own. */
export function isAppJob(reference: unknown): boolean {
  return typeof reference === 'string' && reference.startsWith(APP_JOB_PREFIX)
}

export interface UpstreamDub {
  project_id?: string
  /** The API's own "identify this on your end" field, which is where the name goes. */
  reference?: string
}

export function isDubDeletion(method: string, path: string): boolean {
  return method === 'DELETE' && /^v1\/dubbing\/project\/[^/]+$/.test(path)
}

/**
 * The dubbing calls this app makes, by method.
 *
 * Written out rather than collapsed into `v1/dubbing/.*` because the shape of
 * each one is the guard: `v1/dubbing/project/{id}` reads one project, and
 * `v1/dubbing/project` with nothing after it lists every project in the
 * account. One character of regex separates those, so they are spelled out
 * separately and the list one is simply absent.
 */
const DUBBING_READS = [
  // One project's status, and the transcript whose segments are the script.
  /^v1\/dubbing\/project\/[^/]+$/,
  /^v1\/dubbing\/project\/[^/]+\/transcript$/,
  // How the dub into one language is getting on, and where to fetch it.
  /^v1\/dubbing\/project\/[^/]+\/language\/[^/]+$/,
]

const DUBBING_WRITES = [
  // Start a project over a clip's audio.
  /^v1\/dubbing\/project$/,
  // Add a span the transcription missed.
  /^v1\/dubbing\/project\/[^/]+\/transcript\/segment$/,
  // Add the language to dub into, which is what starts the speaking.
  /^v1\/dubbing\/project\/[^/]+\/language$/,
]

const DUBBING_EDITS = [
  // Every rewritten segment, in one request. The per-segment form is not
  // forwarded because this app does not call it: the segments are one script
  // being written in, and they go together.
  /^v1\/dubbing\/project\/[^/]+\/transcript\/segments$/,
]

const DUBBING_REMOVALS = [
  // A span the transcription found and the captions do not have.
  /^v1\/dubbing\/project\/[^/]+\/transcript\/segment\/[^/]+$/,
]

/**
 * Everything this app asks ElevenLabs for, and nothing else.
 *
 * Notably absent: `v1/user`, which is the account's own plan and usage. It is
 * reachable with a *caller's* key, where it is their account and their business
 * — that is what the "test connection" button in Settings reads — but the site's
 * subscription is not something a visitor needs to see. Absent for the same
 * reason: `v1/dubbing/project` as a GET, which lists every project in the
 * account.
 */
export function isAllowedWithSiteKey(method: string, path: string): boolean {
  if (method === 'GET') {
    return path === 'v1/voices' || path === 'v1/models' || matches(DUBBING_READS, path)
  }
  if (method === 'POST') {
    return (
      /^v1\/speech-to-speech\/[^/]+$/.test(path) ||
      // Where the word timings come from now. Dubbing returns a track and not a
      // syllable of timing with it, so the rendered audio goes back up with the
      // script to be aligned — see `src/lib/dubbing.ts`.
      path === 'v1/forced-alignment' ||
      matches(DUBBING_WRITES, path)
    )
  }
  // PATCH is new to this proxy: nothing before dubbing edited anything upstream,
  // it only ever created and deleted.
  if (method === 'PATCH') return matches(DUBBING_EDITS, path)
  if (method === 'DELETE') {
    return isDubDeletion(method, path) || matches(DUBBING_REMOVALS, path)
  }
  return false
}

function matches(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((pattern) => pattern.test(path))
}
