import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * Who gets into the editor.
 *
 * The gate holds three things at once — a session, a Drive connection, and a
 * folder — and the interesting rules are invisible from the outside. It must not
 * let someone in without Drive or a folder, or they land in an editor that
 * silently saves nothing; and it must not throw them back out when a grant lapses
 * mid-session, which would lose whatever they had open.
 */
const authState = {
  status: 'checking' as string,
  session: null as { user: { email: string } } | null,
  error: null as string | null,
  start: vi.fn(async () => () => {}),
  signIn: vi.fn(),
  signOut: vi.fn(),
  setError: vi.fn(),
}

const driveState = {
  status: 'disconnected' as string,
  error: null as string | null,
  folder: null as { id: string; name: string } | null,
  restore: vi.fn(async () => {}),
  setConnecting: vi.fn(),
  setFolder: vi.fn(),
  adopt: vi.fn(),
  forget: vi.fn(),
}

let signInRequired = true

vi.mock('../state/useAuthStore', () => ({
  requiresSignIn: () => signInRequired,
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    {
      getState: () => authState,
    },
  ),
}))

vi.mock('../state/useDriveStore', () => ({
  useDriveStore: Object.assign(
    (selector: (state: typeof driveState) => unknown) => selector(driveState),
    { getState: () => driveState },
  ),
}))

const loadConnectionStatus = vi.fn<() => Promise<{ durable: boolean; connected: boolean }>>()

vi.mock('../lib/google/gis', () => ({
  isDriveConfigured: () => true,
  loadConnectionStatus: () => loadConnectionStatus(),
}))

vi.mock('../lib/google/identity', () => ({
  createNonce: async () => ({ raw: 'raw', hashed: 'hashed' }),
  requestSignIn: vi.fn(),
}))

const createFolder = vi.fn()
const pickFolder = vi.fn()
let pickerConfigured = true

vi.mock('../lib/google/drive', () => ({ createFolder: (name: string) => createFolder(name) }))
vi.mock('../lib/google/picker', () => ({
  pickFolder: () => pickFolder(),
  isPickerConfigured: () => pickerConfigured,
}))

const { SignInGate } = await import('./SignInGate')

const EDITOR = 'the editor'

function mount() {
  return render(<SignInGate>{EDITOR}</SignInGate>)
}

beforeEach(() => {
  vi.clearAllMocks()
  signInRequired = true
  authState.status = 'signed-out'
  authState.session = null
  authState.error = null
  driveState.status = 'disconnected'
  driveState.error = null
  driveState.folder = null
  pickerConfigured = true
  createFolder.mockResolvedValue({ id: 'folder_new', name: 'editor-cat' })
  pickFolder.mockResolvedValue({ id: 'folder_chosen', name: 'Renders' })
  loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an unconfigured build', () => {
  it('opens the editor with no gate at all, which is what keeps mock mode working', () => {
    signInRequired = false

    mount()

    expect(screen.getByText(EDITOR)).toBeInTheDocument()
  })
})

describe('the gate', () => {
  it('offers one button, which asks for Drive as well as identity', async () => {
    mount()

    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
    // There is no second Google affordance anywhere: one prompt is the point.
    expect(screen.queryByRole('button', { name: /drive/i })).not.toBeInTheDocument()
  })

  it('holds a signed-in visitor who has no Drive connection', async () => {
    // Unticking Drive on Google's screen, or a session made before the app
    // started asking for both. Letting them through would mean an editor that
    // quietly saves nothing.
    authState.status = 'signed-in'
    authState.session = { user: { email: 'someone@example.com' } }

    mount()

    expect(await screen.findByRole('button', { name: /allow google drive/i })).toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('offers a way out to someone stranded with the wrong account', async () => {
    authState.status = 'signed-in'

    mount()

    const escape = await screen.findByRole('button', { name: /use a different account/i })
    escape.click()

    expect(driveState.forget).toHaveBeenCalled()
    expect(authState.signOut).toHaveBeenCalled()
  })

  it('says so when the deployment cannot sign anyone in, instead of a dead button', async () => {
    loadConnectionStatus.mockResolvedValue({ durable: false, connected: false })

    mount()

    expect(await screen.findByText(/not set up for sign-in/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
  })

  it('waits rather than flashing the sign-in screen at a returning visitor', () => {
    authState.status = 'signed-in'
    driveState.status = 'connecting'
    driveState.folder = { id: 'folder_1', name: 'Renders' }

    mount()

    expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('restores Drive itself, since the editor it gates cannot', async () => {
    authState.status = 'signed-in'

    mount()

    await waitFor(() => expect(driveState.restore).toHaveBeenCalled())
  })
})

describe('the folder step', () => {
  it('holds a connected visitor who has nowhere to save', async () => {
    // Letting them through would mean an editor that quietly backs nothing up:
    // uploadAsset returns early without a folder.
    authState.status = 'signed-in'
    driveState.status = 'connected'

    mount()

    expect(
      await screen.findByRole('button', { name: /create an .editor-cat. folder/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('makes a folder in one click, which is the answer most people want', async () => {
    authState.status = 'signed-in'
    driveState.status = 'connected'

    mount()
    ;(await screen.findByRole('button', { name: /create an .editor-cat. folder/i })).click()

    await waitFor(() => expect(createFolder).toHaveBeenCalledWith('editor-cat'))
    await waitFor(() =>
      expect(driveState.setFolder).toHaveBeenCalledWith({ id: 'folder_new', name: 'editor-cat' }),
    )
  })

  it('hands the choice to the Google Picker when they want their own', async () => {
    authState.status = 'signed-in'
    driveState.status = 'connected'

    mount()
    ;(await screen.findByRole('button', { name: /choose an existing folder/i })).click()

    await waitFor(() =>
      expect(driveState.setFolder).toHaveBeenCalledWith({ id: 'folder_chosen', name: 'Renders' }),
    )
  })

  it('offers only what can work when the Picker has no API key', async () => {
    // Creating a folder is a plain Drive call and still works; choosing one is
    // not. Showing a button that can only fail is worse than showing one option.
    pickerConfigured = false
    authState.status = 'signed-in'
    driveState.status = 'connected'

    mount()

    expect(
      await screen.findByRole('button', { name: /create an .editor-cat. folder/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /choose an existing folder/i }),
    ).not.toBeInTheDocument()
  })

  it('stays put when the Picker is closed without choosing', async () => {
    authState.status = 'signed-in'
    driveState.status = 'connected'
    pickFolder.mockResolvedValue(null)

    mount()
    ;(await screen.findByRole('button', { name: /choose an existing folder/i })).click()

    // Cancelling is a decision, not a failure: no folder set, no error shown.
    await waitFor(() => expect(pickFolder).toHaveBeenCalled())
    expect(driveState.setFolder).not.toHaveBeenCalled()
    expect(screen.queryByText(/could not set that folder/i)).not.toBeInTheDocument()
  })
})

describe('once inside', () => {
  it('opens the editor when all three requirements are in place', () => {
    authState.status = 'signed-in'
    driveState.status = 'connected'
    driveState.folder = { id: 'folder_1', name: 'Renders' }

    mount()

    expect(screen.getByText(EDITOR)).toBeInTheDocument()
  })

  it('does not eject someone whose grant lapses mid-session', () => {
    authState.status = 'signed-in'
    driveState.status = 'connected'
    driveState.folder = { id: 'folder_1', name: 'Renders' }

    const view = mount()
    expect(screen.getByText(EDITOR)).toBeInTheDocument()

    // Revoked from the user's Google account page while they were working.
    // Settings reports it; losing the open project over it would be far worse.
    driveState.status = 'needs-reconnect'
    view.rerender(<SignInGate>{EDITOR}</SignInGate>)

    expect(screen.getByText(EDITOR)).toBeInTheDocument()
  })
})
