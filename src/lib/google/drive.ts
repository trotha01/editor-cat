/**
 * The slice of the Drive v3 API this app actually uses.
 *
 * Hand-written against the REST endpoints rather than pulled from `googleapis`:
 * that package targets Node, assumes a service-account style auth chain, and
 * would add tens of megabytes to a browser bundle to cover a handful of calls.
 *
 * Everything here works under `drive.file` alone — creating, renaming,
 * uploading, and reading back files this app made or the user handed over
 * through the Google Picker. `findFolder` lists, but only within that same
 * grant: a list under `drive.file` returns nothing the app did not already have
 * access to, so it can find a project folder we created and nothing else.
 * Searching someone's own Drive is still deliberately absent — that needs a
 * restricted scope, and the Picker does it better. See `picker.ts`.
 */
import { accessToken, invalidateToken } from './gis'
import type { AssetKind } from '../types'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

export class DriveError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'DriveError'
    this.status = status
  }
}

export interface DriveFolder {
  id: string
  name: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  kind: AssetKind
  /** Bytes, absent for Google-native files which we never list anyway. */
  size?: number
  width?: number
  height?: number
  /** Seconds. */
  duration?: number
  thumbnailLink?: string
  modifiedTime?: string
}

export function kindForMime(mimeType: string): AssetKind | null {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return null
}

/**
 * Issues an authenticated Drive request, refreshing the token once on 401.
 *
 * The retry matters because tokens can stop working for reasons our expiry
 * clock cannot see — revocation from the account page, a password change, a
 * session signed out in another tab.
 */
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

  // Retried for rate limits only, never for 5xx. A request Drive throttled
  // provably did not run, whereas a 500 may have applied before failing —
  // retrying that could create a second folder.
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
    return new DriveError(
      404,
      'That Drive item no longer exists. It may have been moved or deleted.',
    )
  }
  if (response.status === 507 || detail.includes('storage quota')) {
    return new DriveError(507, 'Your Google Drive is full. Free some space and try again.')
  }
  return new DriveError(response.status, `Google Drive error${detail ? `: ${detail}` : '.'}`)
}

/** Shared by every call, so shared drives behave like My Drive. */
const SHARED_DRIVE_PARAMS = 'supportsAllDrives=true&includeItemsFromAllDrives=true'

/**
 * A value as Drive's query language wants it: single-quoted, with backslashes
 * and quotes inside escaped.
 *
 * Project folders are named after projects, and project names are typed by the
 * user. Without this, a project called "Bob's cut" closes the quote early and
 * the search comes back a 400 — or, with a name picked for the purpose, comes
 * back as a different search than the one written here.
 */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** The account behind the current token, for display in Settings. */
export async function currentUser(): Promise<{ email: string; name: string }> {
  const response = await driveFetch(`${API}/about?fields=user(emailAddress,displayName)`)
  const body = (await response.json()) as {
    user?: { emailAddress?: string; displayName?: string }
  }
  return {
    email: body.user?.emailAddress ?? '',
    name: body.user?.displayName ?? '',
  }
}

/**
 * Creates a folder and returns it.
 *
 * Offered at first run as the one-click alternative to hunting through the
 * Picker. Creating is something `drive.file` may always do, and the app keeps
 * access to what it created.
 */
export async function createFolder(name: string, parentId = 'root'): Promise<DriveFolder> {
  const response = await driveFetch(`${API}/files?fields=id,name&${SHARED_DRIVE_PARAMS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  return (await response.json()) as DriveFolder
}

/**
 * The folder called `name` directly inside `parentId`, or null if there is none.
 *
 * This is not the Drive search the module note above rules out. Under
 * `drive.file` a list only ever returns files this app created or was handed
 * through the Picker, so the only thing it can turn up here is a project folder
 * we made ourselves — no window onto the user's own files, and nothing beyond
 * what the consent screen already covers.
 *
 * It exists because a folder can be created without that fact reaching us: a
 * create may apply and still fail on the way back, which is precisely why
 * `driveFetch` refuses to retry a 5xx, and the id is recorded in a second write
 * that can fail on its own. Looking the folder up by name is how the next
 * session — or the next machine — finds it again instead of making a second one.
 *
 * `claimed` is the answer to two projects sharing a name, which they routinely
 * do: every project is born "Untitled project". A folder another project has
 * already recorded is not this project's however well the name matches, so it is
 * skipped and the caller makes its own.
 */
export async function findFolder(
  name: string,
  parentId: string,
  claimed: readonly string[] = [],
): Promise<DriveFolder | null> {
  const params = new URLSearchParams({
    q: [
      `name = ${quoted(name)}`,
      `mimeType = ${quoted(FOLDER_MIME)}`,
      `${quoted(parentId)} in parents`,
      'trashed = false',
    ].join(' and '),
    fields: 'files(id,name)',
    // Oldest first, so two machines looking while a duplicate exists settle on
    // the same folder rather than each keeping whichever came back on top.
    orderBy: 'createdTime',
    // Enough to see past a few same-named folders belonging to other projects.
    // Beyond that the honest answer is "none of these are mine", which is what
    // finding nothing means anyway.
    pageSize: '20',
  })

  const response = await driveFetch(`${API}/files?${params.toString()}&${SHARED_DRIVE_PARAMS}`)
  const body = (await response.json()) as { files?: DriveFolder[] }
  return (body.files ?? []).find((folder) => !claimed.includes(folder.id)) ?? null
}

/**
 * Renames a folder, so a project's folder goes on matching the project.
 *
 * Cosmetic on the face of it — uploads go by id, and the id never changes — but
 * the name is also how `findFolder` recognises a folder whose id was never
 * recorded, so letting the two drift quietly costs that recovery.
 */
export async function renameFolder(folderId: string, name: string): Promise<DriveFolder> {
  const response = await driveFetch(
    `${API}/files/${encodeURIComponent(folderId)}?fields=id,name&${SHARED_DRIVE_PARAMS}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  )
  return (await response.json()) as DriveFolder
}

/** Where a folder lives in the Drive web UI, for linking out of the app. */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}

/** Pulls a file's bytes down for local playback and export. */
export async function downloadFile(fileId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await driveFetch(
    `${API}/files/${encodeURIComponent(fileId)}?alt=media&${SHARED_DRIVE_PARAMS}`,
    { signal },
  )
  return await response.blob()
}

export interface UploadOptions {
  name: string
  parentId: string
  /** 0 to 1. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** What an upload tells the caller. The kind is the caller's own to decide. */
export interface UploadedFile {
  id: string
  name: string
  mimeType: string
}

/**
 * Uploads a blob with a resumable session.
 *
 * Resumable is used for every size, not just large files. A single-request
 * upload cannot report progress, and generated video is routinely tens of
 * megabytes — long enough that a silent progress bar reads as a hang.
 */
export async function uploadFile(blob: Blob, options: UploadOptions): Promise<UploadedFile> {
  const params = new URLSearchParams({ uploadType: 'resumable', fields: 'id,name,mimeType' })
  const start = await driveFetch(`${UPLOAD_API}?${params.toString()}&${SHARED_DRIVE_PARAMS}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify({ name: options.name, parents: [options.parentId] }),
    signal: options.signal,
  })

  const sessionUrl = start.headers.get('Location')
  if (!sessionUrl) {
    throw new DriveError(500, 'Google Drive did not start the upload. Try again.')
  }

  const raw = await putWithProgress(sessionUrl, blob, options, await accessToken())
  return { id: raw.id, name: raw.name, mimeType: raw.mimeType }
}

/**
 * PUTs the bytes over XHR rather than fetch.
 *
 * `fetch` has no upload progress event — request body streaming is still not
 * available across browsers — and progress is the entire reason this path is
 * resumable.
 */
function putWithProgress(
  sessionUrl: string,
  blob: Blob,
  options: UploadOptions,
  token: string,
): Promise<UploadedFile> {
  return new Promise<UploadedFile>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    // The signal outlives this upload, so the listener has to come off with it.
    const done = () => options.signal?.removeEventListener('abort', abort)

    xhr.open('PUT', sessionUrl)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    }

    xhr.onload = () => {
      done()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const file = JSON.parse(xhr.responseText) as UploadedFile
          options.onProgress?.(1)
          resolve(file)
        } catch {
          reject(new DriveError(xhr.status, 'Google Drive returned an unreadable response.'))
        }
        return
      }
      reject(new DriveError(xhr.status, `The upload to Google Drive failed (${xhr.status}).`))
    }

    xhr.onerror = () => {
      done()
      reject(new DriveError(0, 'The upload to Google Drive failed.'))
    }
    xhr.onabort = () => {
      done()
      reject(new DOMException('Upload cancelled.', 'AbortError'))
    }

    options.signal?.addEventListener('abort', abort, { once: true })

    xhr.send(blob)
  })
}
