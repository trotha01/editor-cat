/**
 * The slice of the Drive v3 API this app actually uses.
 *
 * Hand-written against the REST endpoints rather than pulled from `googleapis`:
 * that package targets Node, assumes a service-account style auth chain, and
 * would add tens of megabytes to a browser bundle to cover five calls.
 */
import { accessToken, invalidateToken } from './gis'
import type { AssetKind } from '../types'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** The id Drive accepts as "the top of My Drive". */
export const ROOT_FOLDER_ID = 'root'

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

/** Shapes we read back from the API. Only the fields we ask for are declared. */
interface RawFile {
  id: string
  name: string
  mimeType: string
  size?: string
  thumbnailLink?: string
  modifiedTime?: string
  imageMediaMetadata?: { width?: number; height?: number }
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string }
}

interface FileListResponse {
  files?: RawFile[]
  nextPageToken?: string
}

/**
 * Escapes a value for interpolation into a Drive `q` string.
 *
 * Drive quotes query terms with single quotes, so a folder named "Trevor's
 * clips" would otherwise terminate the string early and produce a 400.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
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
async function driveFetch(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await accessToken()
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })

  if (response.status === 401 && retry) {
    invalidateToken()
    return await driveFetch(url, init, false)
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

/** Query parameters every call shares, so shared drives behave like My Drive. */
const SHARED_DRIVE_PARAMS = 'supportsAllDrives=true&includeItemsFromAllDrives=true'

const FILE_FIELDS =
  'id,name,mimeType,size,thumbnailLink,modifiedTime,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis)'

/**
 * Runs a `files.list` query to exhaustion.
 *
 * `maxPages` is a guard, not a preference: a query pointed at a very large
 * Drive would otherwise page forever while the user stares at a spinner.
 */
async function listAll(query: string, maxPages = 20): Promise<RawFile[]> {
  const files: RawFile[] = []
  let pageToken: string | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      q: query,
      fields: `files(${FILE_FIELDS}),nextPageToken`,
      pageSize: '200',
      orderBy: 'folder,name_natural',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const response = await driveFetch(`${API}/files?${params.toString()}&${SHARED_DRIVE_PARAMS}`)
    const body = (await response.json()) as FileListResponse
    files.push(...(body.files ?? []))

    pageToken = body.nextPageToken
    if (!pageToken) break
  }

  return files
}

function toDriveFile(raw: RawFile): DriveFile | null {
  const kind = kindForMime(raw.mimeType)
  if (!kind) return null

  const durationMillis = Number(raw.videoMediaMetadata?.durationMillis)
  const size = Number(raw.size)

  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    kind,
    ...(Number.isFinite(size) ? { size } : {}),
    ...(raw.imageMediaMetadata?.width
      ? { width: raw.imageMediaMetadata.width, height: raw.imageMediaMetadata.height }
      : {}),
    ...(raw.videoMediaMetadata?.width
      ? { width: raw.videoMediaMetadata.width, height: raw.videoMediaMetadata.height }
      : {}),
    ...(Number.isFinite(durationMillis) ? { duration: durationMillis / 1000 } : {}),
    ...(raw.thumbnailLink ? { thumbnailLink: raw.thumbnailLink } : {}),
    ...(raw.modifiedTime ? { modifiedTime: raw.modifiedTime } : {}),
  }
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

/** Immediate subfolders of a folder, for the folder browser. */
export async function listSubfolders(parentId: string): Promise<DriveFolder[]> {
  const raw = await listAll(
    `mimeType = '${FOLDER_MIME}' and '${escapeQueryValue(parentId)}' in parents and trashed = false`,
  )
  return raw.map((file) => ({ id: file.id, name: file.name }))
}

/** A folder's own name and parent, so the browser can show where it is. */
export async function getFolder(folderId: string): Promise<DriveFolder & { parents?: string[] }> {
  const response = await driveFetch(
    `${API}/files/${encodeURIComponent(folderId)}?fields=id,name,parents&${SHARED_DRIVE_PARAMS}`,
  )
  const body = (await response.json()) as { id: string; name: string; parents?: string[] }
  return body
}

/**
 * Every folder at or beneath `rootId`, breadth-first.
 *
 * Drive has no recursive query, so the tree has to be walked. `maxFolders`
 * bounds the walk: pointed at the root of a large Drive this would otherwise
 * issue hundreds of sequential requests.
 */
async function collectFolderIds(rootId: string, maxFolders = 200): Promise<string[]> {
  const seen = new Set<string>([rootId])
  const queue = [rootId]
  const ids: string[] = [rootId]

  while (queue.length > 0 && ids.length < maxFolders) {
    // One level at a time, so sibling folders are fetched together rather than
    // one request deep per folder.
    const level = queue.splice(0, queue.length)
    const batches = await Promise.all(level.map((id) => listSubfolders(id)))

    for (const child of batches.flat()) {
      if (seen.has(child.id) || ids.length >= maxFolders) continue
      seen.add(child.id)
      ids.push(child.id)
      queue.push(child.id)
    }
  }

  return ids
}

/** Splits parent ids into `q` clauses that stay under Drive's query length limit. */
export function parentClauses(folderIds: string[], perQuery = 25): string[] {
  const clauses: string[] = []
  for (let index = 0; index < folderIds.length; index += perQuery) {
    const group = folderIds
      .slice(index, index + perQuery)
      .map((id) => `'${escapeQueryValue(id)}' in parents`)
      .join(' or ')
    clauses.push(`(${group})`)
  }
  return clauses
}

export interface ListMediaOptions {
  /** Include everything beneath the folder, not just its immediate children. */
  recursive?: boolean
  /** Which media types to return. Defaults to images only. */
  kinds?: AssetKind[]
}

/** Media inside a folder, optionally including everything below it. */
export async function listMedia(
  folderId: string,
  { recursive = true, kinds = ['image'] }: ListMediaOptions = {},
): Promise<DriveFile[]> {
  const folderIds = recursive ? await collectFolderIds(folderId) : [folderId]
  const mimeFilter = kinds.map((kind) => `mimeType contains '${kind}/'`).join(' or ')

  const results = await Promise.all(
    parentClauses(folderIds).map((clause) =>
      listAll(`${clause} and (${mimeFilter}) and trashed = false`),
    ),
  )

  const files = results
    .flat()
    .map(toDriveFile)
    .filter((file): file is DriveFile => file !== null)

  // A file can sit in more than one Drive folder, so the same id can arrive
  // from two different parent clauses.
  const unique = new Map(files.map((file) => [file.id, file]))
  return [...unique.values()].sort((a, b) =>
    (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''),
  )
}

/** Creates a folder and returns it. Used for the default "editor-cat" folder. */
export async function createFolder(name: string, parentId = ROOT_FOLDER_ID): Promise<DriveFolder> {
  const response = await driveFetch(`${API}/files?fields=id,name&${SHARED_DRIVE_PARAMS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  return (await response.json()) as DriveFolder
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

/**
 * Uploads a blob with a resumable session.
 *
 * Resumable is used for every size, not just large files. A single-request
 * upload cannot report progress, and generated video is routinely tens of
 * megabytes — long enough that a silent progress bar reads as a hang.
 */
export async function uploadFile(blob: Blob, options: UploadOptions): Promise<DriveFile> {
  const params = new URLSearchParams({ uploadType: 'resumable', fields: FILE_FIELDS })
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
  const file = toDriveFile(raw)
  if (!file) {
    // Drive accepted bytes we cannot classify. The upload worked, so report the
    // id rather than failing, and let the caller's own kind stand.
    return { id: raw.id, name: raw.name, mimeType: raw.mimeType, kind: 'image' }
  }
  return file
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
): Promise<RawFile> {
  return new Promise<RawFile>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'))
      return
    }

    const xhr = new XMLHttpRequest()
    xhr.open('PUT', sessionUrl)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream')

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total)
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          options.onProgress?.(1)
          resolve(JSON.parse(xhr.responseText) as RawFile)
        } catch {
          reject(new DriveError(xhr.status, 'Google Drive returned an unreadable response.'))
        }
        return
      }
      reject(new DriveError(xhr.status, `The upload to Google Drive failed (${xhr.status}).`))
    }

    xhr.onerror = () => reject(new DriveError(0, 'The upload to Google Drive failed.'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'))

    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })

    xhr.send(blob)
  })
}
