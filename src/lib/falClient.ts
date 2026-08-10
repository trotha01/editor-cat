/**
 * fal.ai queue client.
 *
 * All traffic goes through /api/fal (our Netlify function) rather than straight
 * to fal. Two reasons, and the first is the stronger one: the fal key belongs
 * to the deployment and is attached on the way through, so it never exists in
 * the browser at all. The second is that we then do not depend on fal's browser
 * CORS policy. What this side sends instead is the user's session token, which
 * is what the function checks before spending the site's credits.
 *
 * The queue is used rather than the synchronous endpoint because a Netlify
 * function may only run for about ten seconds and video generation takes
 * minutes. So the browser holds the long-running work: submit once, then poll
 * until done. Closing the tab does not lose the job — the request ID is all
 * that is needed to pick it back up.
 */
import { ProviderError, providerErrorFrom } from './errors'
import { isMockEnabled, mockFal } from './mock'
import { supabaseAccessToken } from './supabase/session'

const PROXY_BASE = '/api/fal'
const QUEUE_ORIGIN = 'https://queue.fal.run'

export type QueueStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'

export interface QueueSubmission {
  request_id: string
  status_url: string
  response_url: string
  cancel_url?: string
}

export interface QueueStatusResponse {
  status: QueueStatus
  queue_position?: number
  logs?: { message: string; timestamp?: string }[] | null
}

export interface GenerationProgress {
  status: QueueStatus
  queuePosition?: number
  /** Most recent provider log line, if the model emits any. */
  message?: string
  /** Seconds since submission. */
  elapsed: number
}

/**
 * fal returns absolute status/response URLs. Rewriting them onto our proxy is
 * more reliable than reconstructing the paths ourselves, because for nested
 * model IDs (`fal-ai/flux/dev`) the queue path uses only the first two
 * segments, which is easy to get subtly wrong.
 */
export function toProxyPath(absoluteUrl: string): string {
  if (absoluteUrl.startsWith(QUEUE_ORIGIN)) {
    return `${PROXY_BASE}${absoluteUrl.slice(QUEUE_ORIGIN.length)}`
  }
  try {
    const url = new URL(absoluteUrl)
    return `${PROXY_BASE}${url.pathname}${url.search}`
  } catch {
    return `${PROXY_BASE}/${absoluteUrl.replace(/^\/+/, '')}`
  }
}

async function falFetch(path: string, init?: RequestInit): Promise<Response> {
  // Read per request rather than captured: a video job polls for minutes, and
  // the session is renewed underneath it. Reading it fresh each time is what
  // keeps a long job from failing halfway through on a token that was valid
  // when it started.
  const token = await supabaseAccessToken()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      // Absent on a build with no Supabase project behind it, where the
      // function is expected to be running with anonymous access allowed.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw await providerErrorFrom('fal.ai', response)
  return response
}

export async function submit(
  modelId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<QueueSubmission> {
  const response = await falFetch(`${PROXY_BASE}/${modelId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  return (await response.json()) as QueueSubmission
}

export async function checkStatus(
  statusUrl: string,
  signal?: AbortSignal,
): Promise<QueueStatusResponse> {
  const response = await falFetch(`${toProxyPath(statusUrl)}?logs=1`, { signal })
  return (await response.json()) as QueueStatusResponse
}

export async function fetchResult<T>(responseUrl: string, signal?: AbortSignal): Promise<T> {
  const response = await falFetch(toProxyPath(responseUrl), { signal })
  return (await response.json()) as T
}

/**
 * Polls with a gentle backoff: quick at first so fast image models feel
 * instant, slower later so a three-minute video job does not fire hundreds of
 * requests.
 */
function delayForAttempt(attempt: number): number {
  if (attempt < 5) return 700
  if (attempt < 15) return 1500
  return 3000
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

export interface RunOptions {
  signal?: AbortSignal
  onProgress?: (progress: GenerationProgress) => void
  /** Give up after this long. Video models can legitimately take minutes. */
  timeoutMs?: number
}

/** Submits a job and resolves with its output once the queue reports COMPLETED. */
export async function run<T>(
  modelId: string,
  input: Record<string, unknown>,
  { signal, onProgress, timeoutMs = 15 * 60 * 1000 }: RunOptions = {},
): Promise<T> {
  if (isMockEnabled()) return mockFal<T>(modelId, input, onProgress, signal)

  const startedAt = Date.now()
  const submission = await submit(modelId, input, signal)

  onProgress?.({ status: 'IN_QUEUE', elapsed: 0 })

  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new ProviderError(
        'fal.ai',
        504,
        'Generation timed out.',
        `The job was still running after ${Math.round(timeoutMs / 60000)} minutes. It may still finish on fal's side.`,
      )
    }

    await sleep(delayForAttempt(attempt), signal)

    const status = await checkStatus(submission.status_url, signal)
    const lastLog = status.logs?.at(-1)?.message

    onProgress?.({
      status: status.status,
      queuePosition: status.queue_position,
      message: lastLog,
      elapsed: (Date.now() - startedAt) / 1000,
    })

    if (status.status === 'COMPLETED') {
      return await fetchResult<T>(submission.response_url, signal)
    }
  }
}

/* --- Output shapes ------------------------------------------------------- */

export interface FalImage {
  url: string
  width?: number
  height?: number
  content_type?: string
}

export interface ImageOutput {
  images?: FalImage[]
  /** Some models echo the prompt they actually used after their own rewriting. */
  prompt?: string
}

export interface VideoOutput {
  video?: { url: string; content_type?: string }
}

export interface LlmOutput {
  output?: string
  reasoning?: string | null
}
