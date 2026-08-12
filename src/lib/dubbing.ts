/**
 * ElevenLabs Dubbing, used as a re-voicer rather than as a translator.
 *
 * The other way to fix a clip that says the words with the wrong sounds. Where
 * text-to-speech says each line and leaves the placing to us, dubbing is handed
 * the clip's own audio and hands back one finished track — and in between, the
 * thing worth having: **segments**. A dubbing studio resource is a list of
 * timed, editable spans, and a span's duration is held constant while the
 * speech inside it is sped or slowed to fit. Nothing in text-to-speech can be
 * told when to finish; a segment is nothing but a thing that finishes on time.
 *
 * So the shape of this file is: put the clip's audio up, take the segments
 * back, overwrite them with the captions and the captions' own marks, re-dub,
 * render, download. `clipAudioFix.ts` is where that sequence lives and where
 * the reasoning for each step is; here is only the wire.
 *
 * Two things follow from the segments being ours to set:
 *
 *  - **Nothing is ever translated.** `source_lang` and `target_lang` are the
 *    same language, and `/translate` is never called. The captions are the
 *    script, so a translation step would be the provider replacing the user's
 *    words with its own — see `clipAudioFix.ts`.
 *  - **The transcription barely matters.** Dubbing transcribes the clip to find
 *    its segments, and every one of those texts is overwritten before a word is
 *    re-said. What the transcription buys is the *count* and the speaker, not
 *    the words.
 *
 * No key appears anywhere in this file, exactly as in `elevenlabs.ts`: every
 * call goes through /api/elevenlabs carrying the user's Auth0 session, and the
 * deployment's key is attached inside the function. The paths below are on that
 * proxy's allowlist — see `netlify/lib/elevenlabs.ts`, which is where a new one
 * has to be added before it will reach ElevenLabs at all.
 *
 * A render takes far longer than a Netlify function may run, so the job is held
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
  mockDubbingRender,
  mockDubbingResource,
  mockDubbingUpdateSegment,
} from './mock'

/* --- What comes back ------------------------------------------------------ */

/**
 * One span of the resource: when it is said, and what is said in it.
 *
 * Times are seconds into the media that was uploaded, which here is the clip
 * itself — so a segment's clock and a caption's clock differ by exactly where
 * the clip starts on the timeline, and by nothing else.
 */
export interface DubbingSegment {
  id: string
  start: number
  end: number
  text: string
}

/** A speaker the dub found, and the segments it owns. */
export interface DubbingSpeaker {
  id: string
  segments: string[]
}

/** How a render is getting on. Read by polling the resource it belongs to. */
export type RenderStatus = 'complete' | 'processing' | 'failed'

export interface DubbingResource {
  id: string
  /** In time order, which is the order the captions are in too. */
  segments: DubbingSegment[]
  speakers: DubbingSpeaker[]
  renders: Record<string, { status: RenderStatus }>
  /** What ElevenLabs decided the clip was in, once it has decided. */
  sourceLanguage?: string
}

/* --- Wire shapes ---------------------------------------------------------- */

interface WireSegment {
  id?: string
  start_time?: number
  end_time?: number
  text?: string
}

interface WireResource {
  id?: string
  source_language?: string
  speaker_tracks?: Record<string, { id?: string; segments?: string[] }>
  speaker_segments?: Record<string, WireSegment>
  renders?: Record<string, { status?: string }>
}

interface WireMetadata {
  dubbing_id?: string
  status?: string
  error?: string
}

/* --- Creating the job ----------------------------------------------------- */

export interface CreateDubOptions {
  /** The clip's own audio. Sized by the caller — see `dubbableSeconds`. */
  audio: Blob
  /** What the project is called in the account until it is deleted again. */
  name: string
  /**
   * ISO-639-1, and it is both ends of the pair.
   *
   * Required, unlike the text-to-speech path's optional language. A dubbing job
   * has exactly one target language and everything in it is re-said in that
   * language, so there is no "read it as it is written" to fall back on. The
   * dialog is what makes the user choose; see `FixAudioDialog.tsx`.
   */
  language: string
  /**
   * How long that audio runs.
   *
   * The provider reads it off the media and never sees this. Mock mode has no
   * media to read, and the length is the one property of a dub that everything
   * downstream depends on — where the segments go, how long the rendered track
   * is — so it is passed rather than guessed back out of the WAV's byte count.
   */
  seconds: number
  signal?: AbortSignal
}

/**
 * Starts a dubbing studio job over a clip's audio and returns its id.
 *
 * `dubbing_studio` is the whole point: without it the job is one-shot and
 * produces audio that cannot be edited, and the segments — the only reason to
 * be here rather than in text-to-speech — never exist.
 *
 * `num_speakers: 1` because a clip is one shot of one person talking. Left to
 * detect, a bilingual line said with two different mouths is a plausible two
 * speakers, and the second one would be re-voiced by a different clone.
 *
 * The background is deliberately kept. Dubbing separates speech from everything
 * behind it and mixes them back together on render, and the clip's own sound is
 * about to be muted — so anything dropped here is lost from the finished video
 * rather than merely from the speech.
 */
export async function createDub({
  audio,
  name,
  language,
  seconds,
  signal,
}: CreateDubOptions): Promise<string> {
  if (isMockEnabled()) return mockDubbingCreate(seconds)

  const form = new FormData()
  // The extension matters here as it does everywhere else in this API:
  // ElevenLabs sniffs the container from the filename as well as the bytes.
  form.append('file', audio, 'clip.wav')
  form.append('name', name)
  form.append('source_lang', language)
  form.append('target_lang', language)
  form.append('num_speakers', '1')
  form.append('dubbing_studio', 'true')
  // Watermarking applies to video output; this renders audio, and asking for a
  // watermark on a track that cannot carry one is a way to be refused.
  form.append('watermark', 'false')

  const response = await elevenFetch('/v1/dubbing', { method: 'POST', body: form, signal })
  const body = (await response.json()) as { dubbing_id?: string }
  if (!body.dubbing_id) throw new Error('ElevenLabs started a dub but did not name it.')
  return body.dubbing_id
}

/* --- Reading it ----------------------------------------------------------- */

/** Statuses that mean the first pass is still running. */
const RUNNING = new Set(['dubbing', 'pending', 'queued', 'processing', 'in_progress'])

async function metadata(dubbingId: string, signal?: AbortSignal): Promise<WireMetadata> {
  if (isMockEnabled()) return { dubbing_id: dubbingId, status: 'dubbed' }

  const response = await elevenFetch(`/v1/dubbing/${encodeURIComponent(dubbingId)}`, { signal })
  return (await response.json()) as WireMetadata
}

/**
 * Whether ElevenLabs refused because this workspace is not in the beta.
 *
 * Worth naming rather than passing on as another authorization error, because
 * it is the one failure on this path that no amount of retrying, re-signing-in
 * or key-checking will move — and because it is invisible until this exact
 * call. Creating the job succeeds, the metadata comes back saying
 * `editable: true`, and only reading the resource says the editing API is not
 * available at all. Confirmed against the live API on a deploy preview:
 * `POST /v1/dubbing` answered 200 and `GET /v1/dubbing/resource/{id}` answered
 * 401 `no_dubbing_api_access`.
 */
function isClosedBeta(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    /no_dubbing_api_access|closed[- ]beta/i.test(error.detail ?? '')
  )
}

/** The editable resource: the segments, the speakers, and any renders so far. */
export async function dubbingResource(
  dubbingId: string,
  signal?: AbortSignal,
): Promise<DubbingResource> {
  if (isMockEnabled()) return mockDubbingResource(dubbingId) as DubbingResource

  const response = await elevenFetch(`/v1/dubbing/resource/${encodeURIComponent(dubbingId)}`, {
    signal,
  }).catch((cause: unknown) => {
    if (!isClosedBeta(cause)) throw cause
    throw new ProviderError(
      'ElevenLabs',
      403,
      'This site’s ElevenLabs workspace has not been given access to the Dubbing Studio API.',
      'Fixing a clip’s audio is built on editing a dub’s segments, and that API is in closed ' +
        'beta — the job itself was created and has been deleted again, but its segments cannot ' +
        'be read. Whoever deployed this site needs to ask ElevenLabs for dubbing API access. ' +
        'Nothing you can fix from here.',
    )
  })
  const body = (await response.json()) as WireResource

  const segments = Object.values(body.speaker_segments ?? {})
    .flatMap((segment) =>
      segment.id
        ? [
            {
              id: segment.id,
              start: segment.start_time ?? 0,
              end: segment.end_time ?? 0,
              text: segment.text ?? '',
            },
          ]
        : [],
    )
    // Sorted here rather than trusted, because the wire shape is a map and a
    // map has no order. Everything downstream pairs segments with captions by
    // position, so the order is not a presentational detail.
    .sort((a, b) => a.start - b.start || a.end - b.end)

  return {
    id: body.id ?? dubbingId,
    segments,
    speakers: Object.values(body.speaker_tracks ?? {}).flatMap((track) =>
      track.id ? [{ id: track.id, segments: track.segments ?? [] }] : [],
    ),
    renders: Object.fromEntries(
      Object.entries(body.renders ?? {}).map(([id, render]) => [
        id,
        { status: (render.status ?? 'processing') as RenderStatus },
      ]),
    ),
    ...(body.source_language ? { sourceLanguage: body.source_language } : {}),
  }
}

/**
 * Waits for the first pass — transcribe, separate, segment — to finish.
 *
 * Two conditions rather than one, because they answer different questions and
 * either alone has been enough to hang a job: the status says the provider
 * thinks it is done, and the resource having segments says there is actually
 * something to edit. A status that has gone quiet with no segments behind it is
 * a job that finished by failing.
 */
export async function waitForSegments(
  dubbingId: string,
  { signal, onWait }: { signal?: AbortSignal; onWait?: (elapsed: number) => void } = {},
): Promise<DubbingResource> {
  const startedAt = Date.now()

  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > DUB_TIMEOUT_MS) throw timedOut('preparing')
    await sleep(delayForAttempt(attempt), signal)

    const state = await metadata(dubbingId, signal)
    const status = (state.status ?? '').toLowerCase()
    if (status && !RUNNING.has(status)) {
      if (/fail|error/.test(status)) {
        throw new ProviderError(
          'ElevenLabs',
          502,
          'ElevenLabs could not dub that clip.',
          state.error ?? `The job came back as "${state.status}".`,
        )
      }
      const resource = await dubbingResource(dubbingId, signal)
      if (resource.segments.length > 0) return resource
      throw new ProviderError(
        'ElevenLabs',
        502,
        'ElevenLabs found nothing being said in that clip.',
        'Dubbing splits a clip into spans of speech, and this one came back with none.',
      )
    }
    onWait?.((Date.now() - startedAt) / 1000)
  }
}

/* --- Editing it ----------------------------------------------------------- */

export interface SegmentEdit {
  start: number
  end: number
  text: string
}

/**
 * Sets a segment's words and its span, without re-saying anything.
 *
 * Deliberately two steps from re-saying it: every segment is written first and
 * only then are they all dubbed in one call, so the provider sees the finished
 * script rather than a script being assembled. The language in the path is the
 * target, which for this feature is also the source.
 */
export async function updateSegment(
  dubbingId: string,
  segmentId: string,
  language: string,
  edit: SegmentEdit,
  signal?: AbortSignal,
): Promise<void> {
  if (isMockEnabled()) return mockDubbingUpdateSegment(dubbingId, segmentId, edit)

  await elevenFetch(
    `/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/segment/${encodeURIComponent(segmentId)}/${encodeURIComponent(language)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ start_time: edit.start, end_time: edit.end, text: edit.text }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
}

/** Adds a span the transcription did not find, and returns its id. */
export async function createSegment(
  dubbingId: string,
  speakerId: string,
  edit: SegmentEdit,
  signal?: AbortSignal,
): Promise<string> {
  if (isMockEnabled()) return mockDubbingCreateSegment(dubbingId, edit)

  const response = await elevenFetch(
    `/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/speaker/${encodeURIComponent(speakerId)}/segment`,
    {
      method: 'POST',
      body: JSON.stringify({ start_time: edit.start, end_time: edit.end, text: edit.text }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
  const body = (await response.json()) as { new_segment?: string; id?: string }
  const id = body.new_segment ?? body.id
  if (!id) throw new Error('ElevenLabs added a segment but did not name it.')
  return id
}

/** Removes a span the transcription found and the captions do not have. */
export async function deleteSegment(
  dubbingId: string,
  segmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isMockEnabled()) return mockDubbingDeleteSegment(dubbingId, segmentId)

  await elevenFetch(
    `/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/segment/${encodeURIComponent(segmentId)}`,
    { method: 'DELETE', signal },
  )
}

/**
 * Points the speaker at a voice.
 *
 * `clip-clone` is the default and is what makes a fixed line sound like the
 * clip it stands in for: ElevenLabs copies the voice out of the media it was
 * given, inside its own account, and nothing here has to create or delete a
 * voice to get it. That is the whole of why the clone machinery this feature
 * used to carry is gone — see the module header in `clipAudioFix.ts`.
 */
export async function setSpeakerVoice(
  dubbingId: string,
  speakerId: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isMockEnabled()) return

  await elevenFetch(
    `/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/speaker/${encodeURIComponent(speakerId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ voice_id: voiceId }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
}

/** The voice option that copies the clip's own, in ElevenLabs' vocabulary. */
export const CLIP_CLONE_VOICE = 'clip-clone'

/* --- Saying it again ------------------------------------------------------ */

/** Re-says the named segments. Returns once the request is accepted, not done. */
export async function dubSegments(
  dubbingId: string,
  segmentIds: readonly string[],
  language: string,
  signal?: AbortSignal,
): Promise<void> {
  if (isMockEnabled()) return

  await elevenFetch(`/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/dub`, {
    method: 'POST',
    body: JSON.stringify({ segments: [...segmentIds], languages: [language] }),
    headers: { 'content-type': 'application/json' },
    signal,
  })
}

/** Starts a render of the finished language track and returns its id. */
export async function renderDub(
  dubbingId: string,
  language: string,
  signal?: AbortSignal,
): Promise<string> {
  if (isMockEnabled()) return mockDubbingRender(dubbingId)

  const response = await elevenFetch(
    `/v1/dubbing/resource/${encodeURIComponent(dubbingId)}/render/${encodeURIComponent(language)}`,
    {
      method: 'POST',
      // MP3 rather than the video types: the picture is untouched by this
      // feature, so rendering an MP4 would be paying to re-encode a video in
      // order to throw the video away. The timeline mixes MP3 like any other
      // audio, which is what the text-to-speech path returned too.
      body: JSON.stringify({ render_type: 'mp3', normalize_volume: false }),
      headers: { 'content-type': 'application/json' },
      signal,
    },
  )
  const body = (await response.json()) as { render_id?: string }
  if (!body.render_id) throw new Error('ElevenLabs started a render but did not name it.')
  return body.render_id
}

/**
 * Waits for a render, which is the long half of a run.
 *
 * A render that vanishes from the resource is treated as still running rather
 * than as finished: the map is the provider's, and reading "not there yet" as
 * "done" would download the previous render, or nothing at all.
 */
export async function waitForRender(
  dubbingId: string,
  renderId: string,
  { signal, onWait }: { signal?: AbortSignal; onWait?: (elapsed: number) => void } = {},
): Promise<void> {
  const startedAt = Date.now()

  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > DUB_TIMEOUT_MS) throw timedOut('rendering')
    await sleep(delayForAttempt(attempt), signal)

    const resource = await dubbingResource(dubbingId, signal)
    const status = resource.renders[renderId]?.status
    if (status === 'complete') return
    if (status === 'failed') {
      throw new ProviderError(
        'ElevenLabs',
        502,
        'ElevenLabs could not render the corrected audio.',
        'The segments were re-said, but mixing them down failed.',
      )
    }
    onWait?.((Date.now() - startedAt) / 1000)
  }
}

/** Downloads the dubbed track for a language. */
export async function dubbedAudio(
  dubbingId: string,
  language: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (isMockEnabled()) return await mockDubbingAudio(dubbingId)

  const response = await elevenFetch(
    `/v1/dubbing/${encodeURIComponent(dubbingId)}/audio/${encodeURIComponent(language)}`,
    { headers: { accept: 'audio/mpeg' }, signal },
  )
  return await response.blob()
}

/** Removes the job from the account. Best effort; see `clipAudioFix.ts`. */
export async function deleteDub(dubbingId: string): Promise<void> {
  if (isMockEnabled()) return mockDubbingDelete(dubbingId)

  await elevenFetch(`/v1/dubbing/${encodeURIComponent(dubbingId)}`, { method: 'DELETE' })
}

/* --- Getting the word timings back ---------------------------------------- */

/**
 * When each word was said, from the audio and the text that was said in it.
 *
 * The one thing dubbing does not give back. Text-to-speech returned per-word
 * timings with the audio, and the karaoke highlight is built on them; a render
 * is just a track. Forced alignment is the answer rather than re-running Scribe
 * because it is told the words instead of guessing them — the script is already
 * known exactly, so recognising it again would be spending a request to
 * introduce mistakes. It also returns words directly, where Scribe's answer
 * would have to be reconciled with the captions it was supposed to be timing.
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
