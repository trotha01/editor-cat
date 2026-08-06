import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * How the two Pickers are configured.
 *
 * This is the whole contract with Google: the view decides what the user can
 * choose, and choosing is what grants this app access. Get the folder view wrong
 * and folders can be opened but never selected — a dialog that looks broken. Get
 * the media view wrong and it opens on someone's whole Drive instead of the
 * folder they picked, or offers them Docs the editor cannot use.
 *
 * It also stands in for the scope decision: everything here exists so the app can
 * live on `drive.file` rather than the restricted `drive.readonly`.
 */
vi.mock('./gis', () => ({ accessToken: async () => 'ya29.token' }))

const { pickFolder, pickMedia, resetForTests, isPickerConfigured } = await import('./picker')

/** What a built Picker ended up configured with. */
interface Built {
  token?: string
  key?: string
  appId?: string
  title?: string
  features: string[]
  views: {
    viewId: string
    parent?: string
    mimeTypes?: string
    includeFolders?: boolean
    selectFolderEnabled?: boolean
  }[]
}

let built: Built
let respond: (builder: { callback: (data: unknown) => void }) => void

/** A stand-in for the Picker, which will not load or render under jsdom. */
function installPicker(): void {
  const view = (viewId: string) => {
    const self = {
      viewId,
      setParent(id: string) {
        self.parent = id
        return self
      },
      setMimeTypes(types: string) {
        self.mimeTypes = types
        return self
      },
      setIncludeFolders(on: boolean) {
        self.includeFolders = on
        return self
      },
      setSelectFolderEnabled(on: boolean) {
        self.selectFolderEnabled = on
        return self
      },
    } as Built['views'][number] & Record<string, unknown>
    return self
  }

  const builder = {
    callback: (_data: unknown) => {},
    setOAuthToken(token: string) {
      built.token = token
      return builder
    },
    setDeveloperKey(key: string) {
      built.key = key
      return builder
    },
    setAppId(id: string) {
      built.appId = id
      return builder
    },
    setTitle(title: string) {
      built.title = title
      return builder
    },
    setCallback(fn: (data: unknown) => void) {
      builder.callback = fn
      return builder
    },
    enableFeature(feature: string) {
      built.features.push(feature)
      return builder
    },
    addView(added: Built['views'][number]) {
      built.views.push(added)
      return builder
    },
    build: () => ({
      setVisible: () => {
        // The real Picker answers whenever the user does; the test decides when.
        respond(builder)
      },
    }),
  }

  vi.stubGlobal('gapi', {
    load: (_name: string, opts: { callback: () => void }) => opts.callback(),
  })
  vi.stubGlobal('google', {
    picker: {
      PickerBuilder: function PickerBuilder() {
        return builder
      },
      DocsView: function DocsView(viewId: string) {
        return view(viewId)
      },
      ViewId: { FOLDERS: 'FOLDERS', DOCS: 'DOCS' },
      Action: { PICKED: 'picked', CANCEL: 'cancel' },
      Feature: { MULTISELECT_ENABLED: 'multiselectEnabled' },
    },
  })
}

const picks = (docs: unknown[]) => (builder: { callback: (data: unknown) => void }) =>
  builder.callback({ action: 'picked', docs })

const cancels = (builder: { callback: (data: unknown) => void }) =>
  builder.callback({ action: 'cancel' })

beforeEach(() => {
  built = { features: [], views: [] }
  respond = cancels
  resetForTests()
  vi.stubEnv('VITE_GOOGLE_API_KEY', 'api-key-abc')
  vi.stubEnv('VITE_GOOGLE_PROJECT_NUMBER', '1234567890')
  installPicker()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('configuration', () => {
  it('is unavailable without an API key, since the Picker cannot open at all', async () => {
    vi.stubEnv('VITE_GOOGLE_API_KEY', '')

    expect(isPickerConfigured()).toBe(false)
    await expect(pickFolder()).rejects.toThrow(/VITE_GOOGLE_API_KEY/)
  })

  it('carries the Drive token, the developer key and the app id', async () => {
    respond = picks([{ id: 'folder_1', name: 'Renders' }])

    await pickFolder()

    // The token is what makes the picked files reachable afterwards; the app id
    // is what Google requires for that to hold under drive.file.
    expect(built.token).toBe('ya29.token')
    expect(built.key).toBe('api-key-abc')
    expect(built.appId).toBe('1234567890')
  })
})

describe('pickFolder', () => {
  it('lets a folder actually be selected, not merely opened', async () => {
    respond = picks([{ id: 'folder_1', name: 'Renders' }])

    await expect(pickFolder()).resolves.toEqual({ id: 'folder_1', name: 'Renders' })

    const view = built.views[0]
    expect(view?.viewId).toBe('FOLDERS')
    // Without this the folder view is a dead end: you can browse into folders
    // but the Select button never enables.
    expect(view?.selectFolderEnabled).toBe(true)
  })

  it('treats a cancelled dialog as no choice rather than a failure', async () => {
    respond = cancels

    await expect(pickFolder()).resolves.toBeNull()
  })
})

describe('pickMedia', () => {
  it('opens inside the chosen folder, filtered to what the editor can use', async () => {
    respond = picks([{ id: 'file_1', name: 'shot.png', mimeType: 'image/png', sizeBytes: '2048' }])

    await pickMedia('folder_1')

    const view = built.views[0]
    // Parented, so it reads as "my folder" rather than "my entire Drive".
    expect(view?.parent).toBe('folder_1')
    expect(view?.mimeTypes).toContain('image/png')
    expect(view?.mimeTypes).toContain('video/mp4')
    expect(view?.selectFolderEnabled).toBe(false)
    expect(built.features).toContain('multiselectEnabled')
  })

  it('returns files in the shape the import path already speaks', async () => {
    respond = picks([{ id: 'file_1', name: 'shot.png', mimeType: 'image/png', sizeBytes: '2048' }])

    await expect(pickMedia('folder_1')).resolves.toEqual([
      { id: 'file_1', name: 'shot.png', mimeType: 'image/png', kind: 'image', size: 2048 },
    ])
  })

  it('drops anything the editor cannot open', async () => {
    // A Doc living in the same folder. The mime filter should keep it out of the
    // dialog, but a selection is not something to take on trust.
    respond = picks([
      { id: 'doc_1', name: 'notes', mimeType: 'application/vnd.google-apps.document' },
      { id: 'file_1', name: 'clip.mp4', mimeType: 'video/mp4' },
    ])

    const files = await pickMedia('folder_1')

    expect(files.map((file) => file.id)).toEqual(['file_1'])
  })

  it('returns nothing when the dialog is closed without picking', async () => {
    respond = cancels

    await expect(pickMedia('folder_1')).resolves.toEqual([])
  })
})
