/**
 * Reading files back out of Drive, and nothing else.
 *
 * **This module exists to be deleted.** It is what the one-shot in
 * `../r2/migrate.ts` fetches with, and once every account's bytes are in R2 it
 * and everything under `google/` goes. Drive is no longer where this app keeps
 * anything: media is written to our own bucket at ingest, and the folder tree
 * that used to *be* the word shelf is gone — `word_shelves.doc` was always the
 * real record of it.
 *
 * So this is a much smaller thing than the Drive client it replaces. That one
 * covered folders, uploads, renames, moves, trashing and the Picker, because
 * Drive was the storage. All of that stayed deleted; what came back is one
 * request — download a file by id — plus the retry behaviour around it, which
 * is the part worth keeping rather than rewriting.
 *
 * `drive.file` is still the scope, and it is still per-file: this reaches
 * exactly the files this app created, which is exactly the set that has a
 * `drive_file_id` in the assets table. It is also why the migration cannot be
 * done from outside the app — a different OAuth client cannot see these files
 * at all.
 */
import { accessToken, invalidateToken } from './gis'

const API = 'https://www.googleapis.com/drive/v3'

/** Shared by every call, so shared drives behave like My Drive. */
const SHARED_DRIVE_PARAMS = 'supportsAllDrives=true&includeItemsFromAllDrives=true'

export class DriveError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DriveError'
    this.status = status
  }
}

const MAX_RATE_LIMIT_RETRIES = 4

/**
 * Whether a response is Drive saying "too fast" rather than "no".
 *
 * Drive signals rate limiting as 429, but also as a 403 whose body reason is
 * one of the rate-limit variants — a 403 that means slow down, not forbidden.
 * The body is read from a clone so the original stays intact for the caller.
 */
async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) return true
  if (response.status !== 403) return false

  try {
    const body = (await response.clone().json()) as {
      error?: { errors?: { reason?: string }[] }
    }
    return (body.error?.errors ?? []).some((entry) =>
      ['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded'].includes(
        entry.reason ?? '',
      ),
    )
  } catch {
    return false
  }
}

function backoffDelay(attempt: number): number {
  // Exponential with jitter, which is what Google's own guidance asks for:
  // without the random part, parallel requests retry in lockstep and rebuild
  // the burst that got them throttled.
  return 2 ** attempt * 500 + Math.random() * 500
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted.', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * Issues an authenticated Drive request, refreshing the token once on 401.
 *
 * The retry matters because tokens can stop working for reasons our expiry
 * clock cannot see — revocation from the account page, a password change, a
 * session signed out in another tab. It matters more here than it used to: a
 * migration is a long run of requests, and an hour into one is exactly when a
 * token minted at the start stops being accepted.
 */
async function driveFetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const token = await accessToken()
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })

  // Only the first 401 is worth a retry: if a freshly minted token is also
  // rejected, the problem is not staleness.
  if (response.status === 401 && attempt === 0) {
    invalidateToken()
    return await driveFetch(url, init, attempt + 1)
  }

  // Rate limits only. Everything this module does is a read, so retrying a 5xx
  // would be safe here — but the reads are the whole of it, and leaving the
  // rule as "throttling only" keeps a failure that means something visible
  // rather than buried under four silent attempts.
  if (attempt < MAX_RATE_LIMIT_RETRIES && (await isRateLimited(response))) {
    await sleep(backoffDelay(attempt), init.signal ?? undefined)
    return await driveFetch(url, init, attempt + 1)
  }

  if (!response.ok) throw await driveErrorFrom(response)
  return response
}

async function driveErrorFrom(response: Response): Promise<DriveError> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    detail = body.error?.message ?? ''
  } catch {
    // A non-JSON body (a proxy error page, say) leaves the status to speak.
  }

  if (response.status === 401) {
    return new DriveError(401, 'Your Google session expired. Reconnect Drive in Settings.')
  }
  if (response.status === 403) {
    return new DriveError(
      403,
      detail.includes('quota') || detail.includes('limit')
        ? 'Google Drive rate limit reached. Wait a moment and try again.'
        : `Google Drive refused that request${detail ? `: ${detail}` : '.'}`,
    )
  }
  if (response.status === 404) {
    // Worth distinguishing during a migration: this is the one failure that
    // will never succeed on a later run, because the file is not there to move.
    return new DriveError(
      404,
      'That Drive item no longer exists. It may have been moved or deleted.',
    )
  }
  return new DriveError(response.status, `Google Drive error${detail ? `: ${detail}` : '.'}`)
}

/** Pulls a file's bytes down, so they can be written somewhere we own. */
export async function downloadFile(fileId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await driveFetch(
    `${API}/files/${encodeURIComponent(fileId)}?alt=media&${SHARED_DRIVE_PARAMS}`,
    { signal },
  )
  return await response.blob()
}
