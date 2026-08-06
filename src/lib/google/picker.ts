/**
 * The Google Picker: how the user hands this app a folder, and files inside it.
 *
 * Google's own component, and the reason this app can get by on `drive.file`
 * alone. The Picker runs against the user's Google session rather than our
 * token, so it shows their real Drive; whatever they select is then granted to
 * us per-file. Browsing their Drive ourselves would mean `drive.readonly`, a
 * restricted scope that puts "see and download all your Google Drive files" on
 * the consent screen and needs an annual security assessment to publish.
 *
 * Script-loaded rather than bundled, like every Google client library: they do
 * not publish it to npm, and the endpoints it talks to move.
 */
import { accessToken } from './gis'
import { FOLDER_MIME, kindForMime, type DriveFile, type DriveFolder } from './drive'

const GAPI_SRC = 'https://apis.google.com/js/api.js'

/**
 * Public API key for this deployment, and the Cloud project number.
 *
 * Neither is a secret — the key is restricted by HTTP referrer in the Cloud
 * console, exactly like the client ID is restricted by origin. `appId` is the
 * project number, which Google requires so that files picked here stay reachable
 * under `drive.file` afterwards.
 */
export function apiKey(): string {
  return import.meta.env.VITE_GOOGLE_API_KEY?.trim() ?? ''
}

function appId(): string {
  return import.meta.env.VITE_GOOGLE_PROJECT_NUMBER?.trim() ?? ''
}

/** Whether the deployment can show a Picker at all. */
export function isPickerConfigured(): boolean {
  return apiKey().length > 0
}

let loading: Promise<void> | null = null

/** Loads gapi and its picker module once, shared by every caller. */
function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const done = () => {
      // `gapi.load` is itself async, and the picker namespace does not exist
      // until it finishes.
      gapi.load('picker', {
        callback: () => resolve(),
        onerror: () => {
          loading = null
          reject(new Error('Could not load the Google file picker. Try again.'))
        },
      })
    }

    if (typeof document === 'undefined') {
      reject(new Error('The Google file picker is only available in a browser.'))
      return
    }
    if (typeof window.gapi?.load === 'function') {
      done()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GAPI_SRC}"]`)
    const script = existing ?? document.createElement('script')
    script.addEventListener('load', done)
    script.addEventListener('error', () => {
      // Let a later attempt retry rather than caching the failure forever.
      loading = null
      reject(new Error('Could not reach Google. Check your connection and try again.'))
    })

    if (!existing) {
      script.src = GAPI_SRC
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    }
  })
  return loading
}

/**
 * Runs one Picker and resolves with the documents chosen, or an empty array if
 * the user cancelled.
 *
 * The view is built by the caller because the two uses want very different ones,
 * but everything that must be true of any Picker we show — the OAuth token, the
 * developer key, the app id — lives here so neither call site can forget it.
 */
async function pick(
  build: (picker: google.picker.PickerBuilder) => google.picker.PickerBuilder,
): Promise<google.picker.DocumentObject[]> {
  const key = apiKey()
  if (!key) {
    throw new Error(
      'The Google file picker is not configured for this site: VITE_GOOGLE_API_KEY is not set.',
    )
  }

  // Fetched before the Picker opens: it needs a live token, and a renewal
  // mid-dialog cannot be surfaced to the user.
  const token = await accessToken()
  await loadPicker()

  return await new Promise<google.picker.DocumentObject[]>((resolve) => {
    let builder = new google.picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(key)
      .setCallback((data: google.picker.ResponseObject) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs ?? [])
        // CANCEL, and the close that follows either outcome. Resolving empty
        // rather than rejecting: closing the dialog is a decision, not a fault.
        else if (data.action === google.picker.Action.CANCEL) resolve([])
      })

    const project = appId()
    if (project) builder = builder.setAppId(project)

    build(builder).build().setVisible(true)
  })
}

/** Asks the user which folder new media should be saved into. */
export async function pickFolder(): Promise<DriveFolder | null> {
  const docs = await pick((builder) =>
    builder.setTitle('Choose where editor-cat saves your media').addView(
      new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        // Without this the folder can be opened but never chosen, which reads
        // as a broken dialog.
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME),
    ),
  )

  const folder = docs[0]
  if (!folder) return null
  return { id: folder.id, name: folder.name ?? 'Selected folder' }
}

/** The media types the editor can actually do something with. */
const MEDIA_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
].join(',')

/**
 * Asks the user which media to bring in, opening inside the folder they chose.
 *
 * `setParent` is what makes this read as "browse my folder" rather than "search
 * my whole Drive", while still leaving them free to navigate elsewhere — the
 * Picker is theirs, not ours, and anything they select becomes ours to read.
 */
export async function pickMedia(parentId: string): Promise<DriveFile[]> {
  const docs = await pick((builder) =>
    builder
      .setTitle('Import from Google Drive')
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .addView(
        new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setParent(parentId)
          .setMimeTypes(MEDIA_MIME_TYPES)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(false),
      ),
  )

  return docs.map(toDriveFile).filter((file): file is DriveFile => file !== null)
}

/** Narrows a picked document to the shape the import path already speaks. */
function toDriveFile(doc: google.picker.DocumentObject): DriveFile | null {
  const mimeType = doc.mimeType ?? ''
  const kind = kindForMime(mimeType)
  if (!kind) return null

  const size = Number(doc.sizeBytes)
  return {
    id: doc.id,
    name: doc.name ?? doc.id,
    mimeType,
    kind,
    ...(Number.isFinite(size) ? { size } : {}),
  }
}

/** Test seam: forget the cached script load. */
export function resetForTests(): void {
  loading = null
}
