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
 *
 * The three are three separate screens because they come from three separate
 * places: Netlify Identity signs the user in, Google grants Drive afterwards,
 * and the folder is ours to ask about. The order matters — a Drive prompt in
 * front of someone with no session has no account to file the result under.
 */
const authState = {
  status: 'checking' as string,
  account: null as { id: string; email: string } | null,
  error: null as string | null,
  start: vi.fn(async () => {}),
  signIn: vi.fn(),
  signOut: vi.fn(),
  setError: vi.fn(),
}

const driveState = {
  status: 'disconnected' as string,
  /** Null until the account has been asked what it has stored. */
  durable: true as boolean | null,
  error: null as string | null,
  folder: null as { id: string; name: string } | null,
  restore: vi.fn(async () => {}),
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

const loadConnectionStatus =
  vi.fn<
    () => Promise<{ durable: boolean; connected: boolean; problem?: string; detail?: string }>
  >()
let driveConfigured = true

vi.mock('../lib/google/gis', () => ({
  isDriveConfigured: () => driveConfigured,
  loadConnectionStatus: () => loadConnectionStatus(),
}))

const requestDriveAuthorization = vi.fn<(email?: string) => Promise<string>>()

vi.mock('../lib/google/identity', () => ({
  requestDriveAuthorization: (email?: string) => requestDriveAuthorization(email),
}))

const identityGoogleEnabled = vi.fn<() => Promise<boolean>>()
const sessionReadiness =
  vi.fn<() => Promise<{ ready: boolean; problem?: 'not-configured' | 'unreachable' }>>()

vi.mock('../lib/netlify/identity', () => ({
  identityGoogleEnabled: () => identityGoogleEnabled(),
}))

vi.mock('../lib/supabase/session', () => ({
  sessionReadiness: () => sessionReadiness(),
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
  authState.account = null
  authState.error = null
  driveState.status = 'disconnected'
  driveState.durable = true
  driveState.error = null
  driveState.folder = null
  pickerConfigured = true
  driveConfigured = true
  createFolder.mockResolvedValue({ id: 'folder_new', name: 'editor-cat' })
  pickFolder.mockResolvedValue({ id: 'folder_chosen', name: 'Renders' })
  loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })
  identityGoogleEnabled.mockResolvedValue(true)
  sessionReadiness.mockResolvedValue({ ready: true })
  requestDriveAuthorization.mockResolvedValue('consent-code')
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
  it('offers a sign-in, and asks nothing about Drive yet', async () => {
    mount()

    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
    // Drive comes after. Asking here would have no account to file the grant
    // under, and the function would refuse the code it produced.
    expect(screen.queryByRole('button', { name: /allow google drive/i })).not.toBeInTheDocument()
  })

  it('does not ask the server about Drive before anyone is signed in', () => {
    // `/api/google/status` reports on *this account's* connection, and there is
    // no account yet. Asking would spend a round trip to learn nothing.
    mount()

    expect(loadConnectionStatus).not.toHaveBeenCalled()
  })

  it('holds a signed-in visitor who has no Drive connection', async () => {
    // Netlify Identity signs someone in and grants nothing else, so this is the
    // ordinary path rather than an edge case. Letting them through would mean an
    // editor that quietly saves nothing.
    authState.status = 'signed-in'
    authState.account = { id: 'user_1', email: 'someone@example.com' }

    mount()

    expect(await screen.findByRole('button', { name: /allow google drive/i })).toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('hints the signed-in address, so Google does not ask which account twice', async () => {
    authState.status = 'signed-in'
    authState.account = { id: 'user_1', email: 'someone@example.com' }

    mount()
    ;(await screen.findByRole('button', { name: /allow google drive/i })).click()

    await waitFor(() =>
      expect(requestDriveAuthorization).toHaveBeenCalledWith('someone@example.com'),
    )
    await waitFor(() => expect(driveState.adopt).toHaveBeenCalledWith('consent-code'))
  })

  it('offers a way out to someone stranded with the wrong account', async () => {
    authState.status = 'signed-in'

    mount()

    const escape = await screen.findByRole('button', { name: /use a different account/i })
    escape.click()

    expect(driveState.forget).toHaveBeenCalled()
    expect(authState.signOut).toHaveBeenCalled()
  })

  /**
   * What the sign-in screen says when it cannot offer a button.
   *
   * Two unrelated halves have to be in place — Netlify Identity with Google
   * switched on, and a signing secret to turn that into a Supabase session — and
   * a single "not set up" message covering both sends whoever deployed the site
   * to re-check the half that was already right.
   */
  describe('what stops a sign-in', () => {
    it('names Identity when the site has none, before blaming anything else', async () => {
      // Checked first: without it there is nothing to sign in with, however well
      // the Supabase half is configured.
      identityGoogleEnabled.mockResolvedValue(false)
      sessionReadiness.mockResolvedValue({ ready: false, problem: 'not-configured' })

      mount()

      const callout = await screen.findByRole('alert')
      expect(callout).toHaveTextContent(/Netlify Identity is not enabled/i)
      expect(callout).not.toHaveTextContent('SUPABASE_JWT_SECRET')
      expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
    })

    it('names the signing secret when that is the only thing missing', async () => {
      sessionReadiness.mockResolvedValue({ ready: false, problem: 'not-configured' })

      mount()

      expect(await screen.findByRole('alert')).toHaveTextContent('SUPABASE_JWT_SECRET')
    })

    it('offers a reload for a server that did not answer, not a verdict on the setup', async () => {
      sessionReadiness.mockResolvedValue({ ready: false, problem: 'unreachable' })

      mount()

      const callout = await screen.findByRole('alert')
      expect(callout).toHaveTextContent(/reload/i)
      expect(callout).not.toHaveTextContent(/not set up/i)
    })
  })

  /**
   * Every one of these used to print the same paragraph, naming two environment
   * variables and a migration. Only one of the three was ever the problem, and
   * the reader had no way to tell which — so the screen reliably sent whoever
   * deployed the site to go and re-check something that was already correct.
   */
  describe('what it says is wrong about Drive', () => {
    async function blockedBy(problem: string, detail?: string): Promise<HTMLElement> {
      authState.status = 'signed-in'
      loadConnectionStatus.mockResolvedValue({ durable: false, connected: false, problem, detail })
      mount()
      return await screen.findByRole('alert')
    }

    it('sends someone to the migration, and only the migration, when that is the gap', async () => {
      const callout = await blockedBy('no-table')

      expect(callout).toHaveTextContent('0002_google_connections.sql')
      // The two secrets demonstrably are set: the request got far enough to ask
      // the database a question. Naming them here is what wasted the afternoon.
      expect(callout).not.toHaveTextContent(/GOOGLE_CLIENT_SECRET|SUPABASE_SERVICE_ROLE_KEY/)
    })

    it('offers a reload for a server that did not answer, not a verdict on the setup', async () => {
      const callout = await blockedBy('unreachable')

      expect(callout).toHaveTextContent(/reload/i)
      expect(callout).not.toHaveTextContent(/not set up/i)
    })

    it('quotes the database rather than making someone find the function log', async () => {
      const callout = await blockedBy(
        'unreachable',
        '401 · 42501 · permission denied for table google_connections',
      )

      expect(callout).toHaveTextContent('permission denied for table google_connections')
      // Because that is what a permission complaint from the store points at,
      // and guessing wrong here is how the last three rounds were spent.
      expect(callout).toHaveTextContent('SUPABASE_SERVICE_ROLE_KEY')
    })

    it('names the two secrets only when the deployment really is missing them', async () => {
      const callout = await blockedBy('not-configured')

      expect(callout).toHaveTextContent('GOOGLE_CLIENT_SECRET')
      expect(callout).toHaveTextContent('SUPABASE_SERVICE_ROLE_KEY')
      expect(callout).not.toHaveTextContent('0002_google_connections.sql')
    })

    it('blames the bundle when it was built without a Google client id', async () => {
      // The server half can be flawless and this still cannot work, so it is
      // checked before the server's answer is even considered.
      driveConfigured = false
      authState.status = 'signed-in'
      loadConnectionStatus.mockResolvedValue({ durable: true, connected: false })

      mount()

      expect(await screen.findByRole('alert')).toHaveTextContent('VITE_GOOGLE_CLIENT_ID')
      expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
    })
  })

  it('waits rather than flashing the sign-in screen at a returning visitor', () => {
    authState.status = 'signed-in'
    driveState.status = 'connecting'
    driveState.folder = { id: 'folder_1', name: 'Renders' }

    mount()

    expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('waits for the account to be asked before saying Drive is not connected', () => {
    // `restore` runs from an effect, a paint later than the first render. Until
    // it answers, "disconnected" only means "not asked yet" — and showing the
    // grant screen on the strength of it tells a returning visitor to hand over
    // permission they gave months ago.
    authState.status = 'signed-in'
    driveState.status = 'disconnected'
    driveState.durable = null

    mount()

    expect(screen.queryByRole('button', { name: /allow google drive/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/one more permission/i)).not.toBeInTheDocument()
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
