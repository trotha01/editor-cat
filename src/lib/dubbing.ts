/**
 * ElevenLabs Dubbing, used as a re-voicer rather than as a translator.
 *
 * The other way to fix a clip that says the words with the wrong sounds. Where
 * text-to-speech says each line and leaves the placing to us, dubbing is handed
 * the clip's own audio and hands back one finished track — and in between, the
 * thing worth having: a **transcript of timed segments that can be edited**. A
 * segment's span is held while the speech inside it is fitted to it. Nothing in
 * text-to-speech can be told when to finish; a segment is nothing but a thing
 * that finishes on time.
 *
 * So the shape of this file is: put the clip's audio up, take the transcript
 * back, overwrite its segments with the captions and the captions' own marks,
 * add a language target, wait for it, download. `clipAudioFix.ts` is where that
 * sequence lives and where the reasoning for each step is; here is only the wire.
 *
 * ## Which dubbing API
 *
 * The **project** API (`/v1/dubbing/project/…`), not the older dubbing
 * **resource** API (`/v1/dubbing/resource/…`). This was built against the
 * resource one first, and a run against a deploy preview answered
 * `401 no_dubbing_api_access` — "This API is in closed-beta and is only
 * available to workspaces that are granted access" — after the job had already
 * been created and reported itself as `editable`. The project API is the
 * documented, current one and models the same thing better: segment edits are
 * bulk in one request, and creating a language target does the dubbing and the
 * mixing in one step rather than needing a separate dub and render.
 *
 * Two things follow from the segments being ours to set:
 *
 *  - **Nothing is ever translated.** The language target is created in the same
 *    language the source was transcribed in, and the target transcript's
 *    translations are never asked for or used. The captions are the script, so
 *    a translation step would be the provider replacing the user's words with
 *    its own — see `clipAudioFix.ts`.
 *  - **The transcription barely matters.** Dubbing transcribes the clip to find
 *    its segments, and every one of those texts is overwritten before a word is
 *    re-said. What the transcription buys is the *count*, the speaker ids and
 *    the fact that there is something to edit — not the words.
 *
 * The order matters and is easy to get wrong: the language target is created
 * **after** the segments have been rewritten, never at the same time as the
 * project. Creating a project with `target_language` set queues the dub to start
 * the moment transcription finishes, which is before the captions have been
 * written in — so it would dub the transcriber's words and then go `stale`.
 *
 * No key appears anywhere in this file, exactly as in `elevenlabs.ts`: every
 * call goes through /api/elevenlabs carrying the user's Auth0 session, and the
 * deployment's key is attached inside the function. The paths below are on that
 * proxy's allowlist — see `netlify/lib/elevenlabs.ts`, which is where a new one
 * has to be added before it will reach ElevenLabs at all. The one exception is
 * the finished audio, which arrives as a signed URL and is fetched directly;
 * see `dubbedAudio`.
 *
 * A dub takes far longer than a Netlify function may run, so the job is held
 * here and polled, following `falClient.ts`: submit, back off, honour the
 * signal, report progress. Every poll is its own authenticated request.
 */
import { elevenFetch, type SpokenWord } from './elevenlabs'
import { sleep } from './falClient'
import { ProviderError } from './errors'
import {
  isMockEnabled,
  mockDubbingAlign,
  mockDubbingAudio,
  mockDubbingCreate,
  mockDubbingCreateSegment,
  mockDubbingDelete,
  mockDubbingDeleteSegment,
  mockDubbingLanguage,
  mockDubbingTranscript,
  mockDubbingUpdateSegments,
} from './mock'

/* --- What comes back ------------------------------------------------------ */

/**
 * One segment of the source transcript: when it is said, and what is said.
 *
 * Times are seconds into the media that was uploaded, which here is the clip
 * itself — so a segment's clock and a caption's clock differ by exactly where
 * the clip starts on the timeline, and by nothing else.
 */
export interface DubbingSegment {
  id: string
  text: string
  /** Which speaker owns it. A new segment has to name one of these. */
  speakerId: string
  start: number
  end: number
}

export interface DubbingTranscript {
  /** In playback order, which is the order the captions are in too. */
  segments: DubbingSegment[]
  /** Bumped by every segment edit. Read back to tell a stale dub from a fresh one. */
  revision: number
}

/* --- Wire shapes ---------------------------------------------------------- */

interface WireSegment {
  id?: string
  text?: string
  speaker_id?: string
  start_s?: number
  end_s?: number
}

interface WireTranscript {
  segments?: WireSegment[]
  revision?: number
}

interface WireProject {
  project_id?: string
  status?: string
  revision?: number
  error?: { message?: string; code?: string } | null
}

interface WireLanguage {
  language_id?: string
  status?: string
  outputs?: { lossless_audio?: string } | null
  revision?: number
  output_revision?: number | null
  error?: { message?: string; code?: string } | null
}

/* --- Creating the project ------------------------------------------------- */

export interface CreateProjectOptions {
  /** The clip's own audio. Sized by the caller — see `dubbableSeconds`. */
  audio: Blob
  /**
   * What the project is called in the account until it is deleted again.
   *
   * The API's `reference` field — "free-form to identify the project on your
   * end" — which is exactly what this is for. The proxy reads it back before it
   * will delete anything; see `netlify/lib/elevenlabs.ts`.
   */
  reference: string
  /**
   * BCP-47, and it is both ends of the pair.
   *
   * Required, unlike the text-to-speech path's optional language. A dubbing
   * project transcribes in one language and each target re-says everything in
   * one language, so there is no "read it as it is written" to fall back on.
   * The dialog is what makes the user choose; see `FixAudioDialog.tsx`.
   */
  language: string
  /**
   * How long that audio runs.
   *
   * The provider reads it off the media and never sees this. Mock mode has no
   * media to read, and the length is the one property of a dub that everything
   * downstream depends on — where the segments go, how long the finished track
   * is — so it is passed rather than guessed back out of the WAV's byte count.
   */
  seconds: number
  signal?: AbortSignal
}

/**
 * Starts a dubbing project over a clip's audio and returns its id.
 *
 * `target_language` is deliberately **not** sent. It is offered as a shortcut
 * that also creates a language target, queued to start the moment transcription
 * finishes — which is before this app has written the captions into the
 * transcript. That would dub the transcriber's words, and then go stale the
 * instant the first segment was corrected. The target is created afterwards, by
 * `createLanguageTarget`, once the script is in place.
 *
 * `model_id` is left to the system default rather than pinned: a dubbing model
 * id is a fact about ElevenLabs on a given day, and this app has no reason to
 * prefer one, exactly as `findConversionModel` reasons about voice models.
 */
export async function createDubbingProject({
  audio,
  reference,
  language,
  seconds,
  signal,
}: CreateProjectOptions): Promise<string> {
  if (isMockEnabled()) return mockDubbingCreate(seconds)

  const form = new FormData()
  // The extension matters here as it does everywhere else in this API:
  // ElevenLabs sniffs the container from the filename as well as the bytes.
  form.append('file', audio, 'clip.wav')
  form.append('reference', reference)
  // Named rather than auto-detected. The clips this exists for say their line
  // twice, in two languages, and letting the transcriber pick means it picks
  // one of them — see the live run in the PR, where a half-Latin clip came back
  // detected as English.
  form.append('source_language', language)

  const response = await elevenFetch('/v1/dubbing/project', {
    method: 'POST',
    body: form,
    signal,
  })
  const body = (await response.json()) as WireProject
  if (!body.project_id) throw new Error('ElevenLabs started a dub but did not name it.')
  return body.project_id
}

/* --- Reading it ----------------------------------------------------------- */

/** Project statuses that mean transcription is still running. */
const PREPARING = new Set(['queued', 'preparing', 'processing'])

async function project(projectId: string, signal?: AbortSignal): Promise<WireProject> {
  if (isMockEnabled()) return { project_id: projectId, status: 'ready' }

  const response = await elevenFetch(`/v1/dubbing/project/${encodeURIComponent(projectId)}`, {
    signal,
  }).catch(refuseClosedBeta)
  return (await response.json()) as WireProject
}

/** The source transcript: the segments as the transcriber found them. */
export async function dubbingTranscript(
  projectId: string,
  signal?: AbortSignal,
): Promise<DubbingTranscript> {
  if (isMockEnabled()) return mockDubbingTranscript(projectId)

  const response = await elevenFetch(
    `/v1/dubbing/project/${encodeURIComponent(projectId)}/transcript`,
    { signal },
  ).catch(refuseClosedBeta)
  const body = (await response.json()) as WireTranscript

  return {
    revision: body.revision ?? 0,
    segments: (body.segments ?? []).flatMap((segment) =>
      segment.id
        ? [
            {
              id: segment.id,
              text: segment.text ?? '',
              speakerId: segment.speaker_id ?? '',
              start: segment.start_s ?? 0,
              end: segment.end_s ?? 0,
            },
          ]
        : [],
    ),
  }
}

/**
 * Waits for transcription, then hands back what it found.
 *
 * Two conditions rather than one, because they answer different questions and
 * either alone has been enough to hang a job: the status says the provider
 * thinks it is done, and the transcript having segments says there is actually
 * something to edit. A project that went ready with nothing in it is a clip
 * with no speech in it, which is worth saying rather than dubbing silence.
 */
export async function waitForTranscript(
  projectId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DubbingTranscript> {
  const startedAt = Date.now()

  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > DUB_TIMEOUT_MS) throw timedOut('preparing')
    await sleep(delayForAttempt(attempt), signal)

    const state = await project(projectId, signal)
    const status = (state.status ?? '').toLowerCase()
    if (status && !PREPARING.has(status)) {
      if (status === 'failed' || /fail|error/.test(status)) {
        throw new ProviderError(
          'ElevenLabs',
          502,
          'ElevenLabs could not prepare that clip for dubbing.',
          state.error?.message ?? `The project came back as "${state.status}".`,
        )
      }
      const transcript = await dubbingTranscript(projectId, signal)
      if (transcript.segments.length > 0) return transcript
      throw new ProviderError(
        'ElevenLabs',
        502,
        'ElevenLabs found nothing being said in that clip.',
        'Dubbing splits a clip into spans of speech, and this one came back with none.',
      )
    }
  }
}

/* --- Editing the script onto it ------------------------------------------- */

export interface SegmentEdit {
  start: number
  end: number
  text: string
}

/**
 * Rewrites several segments in one request.
 *
 * Bulk rather than one call each, which is what the API offers and what this
 * wants: the segments are one script being written in, so sending them together
 * is both fewer round trips and one revision bump rather than a run of them.
 */
export async function updateSegments(
  projectId: string,
  edits: Readonly<Record<string, SegmentEdit>>,
  signal?: AbortSignal,
): Promise<void> {
  const entries = Object.entries(edits)
  if (entries.length === 0) return
  if (isMockEnabled()) return mockDubbingUpdateSegments(projectId, edits)

  await elevenFetch(`/v1/dubbing/project/${encodeURIComponent(projectId)}/transcript/segments`, {
    method: 'PATCH',
    body: JSON.stringify({
      segments: Object.fromEntries(
        entries.map(([id, edit]) => [
          id,
          { text: edit.text, start_s: edit.start, end_s: edit.end },
        ]),
      ),
    }),
    headers: { 'content-type': 'application/json' },
    signal,
  })
}

/** Adds a span the transcription missed, and returns its id. */
export async function createSegment(
  projectId: string,
  speakerId: string,
  edit: SegmentEdit,
  signal?: AbortSignal,
): Promise<string> {
  if (isMockEnabled()) return mockDubbingCreateSegment(projectId, edit)

  const response = await elevenFetch(
    `/v1/dubbing/project/${encodeURIComponent(projectId)}/transcript/segment`,
    {
      method: 'POST',
      body: JSON.stringify({
        text: edit.text,
        speaker_id: speakerId,
        start_s: edit.start,
        end_s: edit.end,
      }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
  const body = (await response.json()) as { segment_id?: string; id?: string }
  const id = body.segment_id ?? body.id
  if (!id) throw new Error('ElevenLabs added a segment but did not name it.')
  return id
}

/** Removes a span the transcription found and the captions do not have. */
export async function deleteSegment(
  projectId: string,
  segmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isMockEnabled()) return mockDubbingDeleteSegment(projectId, segmentId)

  await elevenFetch(
    `/v1/dubbing/project/${encodeURIComponent(projectId)}/transcript/segment/${encodeURIComponent(segmentId)}`,
    { method: 'DELETE', signal },
  )
}

/* --- Saying it again ------------------------------------------------------ */

/**
 * Adds the language to dub into, which is what starts the speaking.
 *
 * The same language the project was transcribed in, always. This is a
 * re-voicing: the words are already the user's, sitting in the segments, and
 * asking for a different target would be asking for them to be translated.
 *
 * Created after the script is in, never before — see the module header.
 */
export async function createLanguageTarget(
  projectId: string,
  language: string,
  signal?: AbortSignal,
): Promise<string> {
  if (isMockEnabled()) return mockDubbingLanguage(projectId)

  const response = await elevenFetch(
    `/v1/dubbing/project/${encodeURIComponent(projectId)}/language`,
    {
      method: 'POST',
      body: JSON.stringify({ target_language: language }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
  const body = (await response.json()) as WireLanguage
  if (!body.language_id)
    throw new Error('ElevenLabs started dubbing but did not name the language.')
  return body.language_id
}

/** Language-target statuses that mean it is still being said. */
const DUBBING = new Set(['queued', 'processing'])

/**
 * Waits for the dub, and returns where to download it from.
 *
 * `stale` is treated as a failure rather than as a result, and that is
 * deliberate. It means the transcript changed after the audio was made, so the
 * audio says something other than what the segments now say — which is exactly
 * the disagreement between what is heard and what is burnt into the video that
 * this whole feature exists to prevent. Laying it down would be worse than
 * failing.
 */
export async function waitForDub(
  projectId: string,
  languageId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  const startedAt = Date.now()

  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > DUB_TIMEOUT_MS) throw timedOut('dubbing')
    await sleep(delayForAttempt(attempt), signal)

    const state = await languageTarget(projectId, languageId, signal)
    const status = (state.status ?? '').toLowerCase()
    if (DUBBING.has(status)) continue

    if (status === 'completed') {
      const url = state.outputs?.lossless_audio
      if (!url) {
        throw new ProviderError(
          'ElevenLabs',
          502,
          'ElevenLabs finished dubbing but returned no audio.',
          'The language target reported itself complete with no output to download.',
        )
      }
      return url
    }

    throw new ProviderError(
      'ElevenLabs',
      502,
      status === 'stale'
        ? 'The corrected audio no longer matches the script it was made from.'
        : 'ElevenLabs could not dub that clip.',
      state.error?.message ??
        (status === 'stale'
          ? 'The transcript changed after the audio was generated, so what it says and what the captions say would disagree.'
          : `The dub came back as "${state.status}".`),
    )
  }
}

async function languageTarget(
  projectId: string,
  languageId: string,
  signal?: AbortSignal,
): Promise<WireLanguage> {
  if (isMockEnabled()) return mockDubbingLanguageState(projectId, languageId)

  const response = await elevenFetch(
    `/v1/dubbing/project/${encodeURIComponent(projectId)}/language/${encodeURIComponent(languageId)}`,
    { signal },
  ).catch(refuseClosedBeta)
  return (await response.json()) as WireLanguage
}

function mockDubbingLanguageState(projectId: string, languageId: string): WireLanguage {
  return {
    language_id: languageId,
    status: 'completed',
    outputs: { lossless_audio: `mock://dub/${projectId}` },
  }
}

/**
 * Downloads the finished track.
 *
 * The one request in this file that does not go through the proxy, because it
 * does not need to: the URL is signed and time-limited by ElevenLabs and
 * carries its own authorisation, so no key is involved and the arrangement that
 * keeps keys out of the browser is untouched. Sending it through the proxy
 * would mean teaching the proxy to fetch an arbitrary URL, which is a much
 * larger hole than this closes.
 *
 * Its origin is not `api.elevenlabs.io`, so it depends on that origin allowing
 * a cross-origin GET. If it does not, this is where a run fails.
 */
export async function dubbedAudio(url: string, signal?: AbortSignal): Promise<Blob> {
  if (isMockEnabled()) return await mockDubbingAudio(url.replace('mock://dub/', ''))

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new ProviderError(
      'ElevenLabs',
      response.status,
      'The corrected audio could not be downloaded.',
      'ElevenLabs finished the dub and gave a link to it, but the link could not be fetched.',
    )
  }
  return await response.blob()
}

/** Removes the project from the account. Best effort; see `clipAudioFix.ts`. */
export async function deleteDubbingProject(projectId: string): Promise<void> {
  if (isMockEnabled()) return mockDubbingDelete(projectId)

  await elevenFetch(`/v1/dubbing/project/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

/* --- Getting the word timings back ---------------------------------------- */

/**
 * When each word was said, from the audio and the text that was said in it.
 *
 * The one thing dubbing does not give back. Text-to-speech returned per-word
 * timings with the audio, and the karaoke highlight is built on them; a dub is
 * just a track, and its transcript is timed per segment and no finer. Forced
 * alignment is the answer rather than re-running Scribe because it is told the
 * words instead of guessing them — the script is already known exactly, so
 * recognising it again would be spending a request to introduce mistakes. It
 * also returns words directly, where Scribe's answer would have to be reconciled
 * with the captions it was supposed to be timing.
 */
export async function alignWords(
  audio: Blob,
  text: string,
  signal?: AbortSignal,
): Promise<SpokenWord[]> {
  if (isMockEnabled()) return await mockDubbingAlign()

  const form = new FormData()
  form.append('file', audio, 'dubbed.mp3')
  form.append('text', text)

  const response = await elevenFetch('/v1/forced-alignment', {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json' },
    signal,
  })
  const body = (await response.json()) as {
    words?: { text?: string; start?: number; end?: number }[]
  }

  return (body.words ?? []).flatMap((word) =>
    word.text?.trim()
      ? [{ text: word.text, start: word.start ?? 0, end: word.end ?? word.start ?? 0 }]
      : [],
  )
}

/* --- Failures worth naming ------------------------------------------------ */

/**
 * Turns "you are not in the beta" into a sentence that says so.
 *
 * Worth naming rather than passing on as another authorization error, because
 * it is the one failure on this path that no amount of retrying, re-signing-in
 * or key-checking will move — and because it is invisible until it happens.
 * This was confirmed against the live API on the *resource* API this file used
 * to call: creating the job answered 200 and reported `editable: true`, and only
 * reading its segments answered `401 no_dubbing_api_access`. The project API
 * called here is the documented current one and may well not be gated the same
 * way, but the failure shape is worth keeping either way — it costs one
 * predicate and it is the difference between a comprehensible message and being
 * told to sign in again about a closed beta.
 */
function isClosedBeta(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    /no_dubbing_api_access|closed[- ]beta/i.test(error.detail ?? '')
  )
}

function refuseClosedBeta(cause: unknown): never {
  if (!isClosedBeta(cause)) throw cause
  throw new ProviderError(
    'ElevenLabs',
    403,
    'This site’s ElevenLabs workspace has not been given access to the dubbing API.',
    'Fixing a clip’s audio is built on editing a dub’s segments, and that API is in closed ' +
      'beta for this workspace — any project it created has been deleted again. Whoever deployed ' +
      'this site needs to ask ElevenLabs for dubbing API access. Nothing you can fix from here.',
  )
}

/* --- Pacing --------------------------------------------------------------- */

/**
 * Give up after this long.
 *
 * Generously long, and the reason is that this is one job rather than several:
 * the text-to-speech path failed a line at a time and the lines already said
 * were still worth having, where a dub abandoned halfway is the whole fix lost.
 */
const DUB_TIMEOUT_MS = 12 * 60 * 1000

function timedOut(what: string): ProviderError {
  return new ProviderError(
    'ElevenLabs',
    504,
    `Dubbing timed out while ${what}.`,
    `The job was still going after ${Math.round(DUB_TIMEOUT_MS / 60000)} minutes. It may still finish on ElevenLabs' side.`,
  )
}

/**
 * The same shape of backoff `falClient.ts` uses, and for the same reason —
 * except that nothing here is ever fast, so it starts slower. A dub of a short
 * clip is tens of seconds at best, so polling twice a second at the start would
 * be a hundred requests spent on the part where the answer is certainly "no".
 */
function delayForAttempt(attempt: number): number {
  if (attempt < 5) return 1500
  if (attempt < 15) return 3000
  return 5000
}
