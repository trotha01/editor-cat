/**
 * The slice of the Drive v3 API this app actually uses.
 *
 * Hand-written against the REST endpoints rather than pulled from `googleapis`:
 * that package targets Node, assumes a service-account style auth chain, and
 * would add tens of megabytes to a browser bundle to cover four calls.
 *
 * Everything here works under `drive.file` alone — creating, uploading,
 * and reading back files this app made or the user handed over through the
 * Google Picker. Searching someone's existing Drive is deliberately absent: that
 * needs a restricted scope, and the Picker does it better. See `picker.ts`.
 *
 * `listChildren` is not that search, and the difference is the whole reason it
 * is allowed to exist: `files.list` under `drive.file` answers with the app's own
 * files and nothing else, so looking inside a folder this app made shows what
 * this app put there. That is what lets the word pages find their own language
 * and word folders again on a second machine — and it is also why a folder
 * somebody made by hand in Drive is invisible until they hand it over.
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

/** One thing inside a folder — a file or a folder of its own. */
export interface DriveChild {
  id: string
  name: string
  mimeType: string
}

export function isFolder(child: DriveChild): boolean {
  return child.mimeType === FOLDER_MIME
}

/**
 * What is inside a folder, as far as this app is allowed to see.
 *
 * Trashed items are left out: a language folder somebody deleted has not gone
 * anywhere Drive cannot get it back from, but it has stopped being part of the
 * shelf, and listing it would put it straight back on screen.
 *
 * Paged through to the end rather than taking the first hundred. A word folder
 * holds a handful of takes, but the folder holding every language of a big shelf
 * can be long, and a list that silently stops is a language that silently
 * vanishes.
 */
export async function listChildren(parentId: string, signal?: AbortSignal): Promise<DriveChild[]> {
  const children: DriveChild[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: '200',
      // Both halves of the ordering matter: folders before files so a language's
      // words are read before its stray uploads, and name order so a shelf reads
      // the same way twice.
      orderBy: 'folder, name',
      ...(pageToken ? { pageToken } : {}),
    })
    const response = await driveFetch(`${API}/files?${params.toString()}&${SHARED_DRIVE_PARAMS}`, {
      signal,
    })
    const body = (await response.json()) as { files?: DriveChild[]; nextPageToken?: string }
    children.push(...(body.files ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)

  return children
}

/**
 * Replaces a file's contents, leaving its id — and therefore every reference to
 * it — alone.
 *
 * For the small JSON the word pages keep beside the videos, which is rewritten
 * every time a take is relabelled. Uploading a new file each time would leave a
 * folder full of them.
 */
export async function updateFileContent(fileId: string, blob: Blob): Promise<void> {
  await driveFetch(
    `${UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=media&${SHARED_DRIVE_PARAMS}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    },
  )
}

/**
 * Renames a file or folder, leaving its id — and everything pointing at it —
 * alone.
 *
 * Which is what makes renaming safe here: the shelf is matched to Drive by
 * folder id, so a tier renamed on one machine is the same tier on the next one
 * rather than a new one beside the old.
 */
export async function renameFile(fileId: string, name: string): Promise<void> {
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?${SHARED_DRIVE_PARAMS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/**
 * Moves a file or folder to the Drive trash.
 *
 * Trash rather than delete, deliberately: this is the user's own Drive, and a
 * mis-click on a language should be answerable from Drive's own bin rather than
 * being the end of a folder of recordings. Trashing a folder takes what is in it
 * along, which is what makes deleting a word one call rather than one per take.
 */
export async function trashFile(fileId: string): Promise<void> {
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?${SHARED_DRIVE_PARAMS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  })
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
