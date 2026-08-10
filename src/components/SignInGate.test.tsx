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
 * places: Auth0 signs the user in, Google grants Drive afterwards, and the
 * folder is ours to ask about. The order matters — a Drive prompt in front of
 * someone with no session has no account to file the result under.
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
  connect: vi.fn(),
  setFolder: vi.fn(),
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

let auth0Configured = true

vi.mock('../lib/auth0/client', () => ({
  isAuth0Configured: () => auth0Configured,
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
  auth0Configured = true
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
    // The ordinary path rather than an edge case: a login establishes the
    // account and stocks Token Vault with nothing, so every new user arrives
    // here. Letting them through would mean an editor that quietly saves
    // nothing.
    authState.status = 'signed-in'
    authState.account = { id: 'user_1', email: 'someone@example.com' }

    mount()

    expect(await screen.findByRole('button', { name: /allow google drive/i })).toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('asks for the grant without disturbing the session', async () => {
    // The connect flow, not a fresh login. What is missing is a permission, and
    // signing the user out to collect it would cost them their session to fix
    // something the session was never the problem with.
    authState.status = 'signed-in'
    authState.account = { id: 'user_1', email: 'someone@example.com' }

    mount()
    ;(await screen.findByRole('button', { name: /allow google drive/i })).click()

    await waitFor(() => expect(driveState.connect).toHaveBeenCalled())
    expect(authState.signOut).not.toHaveBeenCalled()
    expect(driveState.forget).not.toHaveBeenCalled()
  })

  /**
   * What the sign-in screen says when it cannot offer a button.
   *
   * This used to be a round trip. The half that could be missing was a signing
   * secret only the functions could see, so the gate asked `GET /api/session`
   * before drawing anything and had three answers to tell apart — configured,
   * not configured, and no answer at all. Supabase validates the Auth0 token
   * itself now, that endpoint is gone, and what is left is compiled into this
   * bundle: one check, answered on the first render.
   *
   * The rule it enforces is unchanged and is the reason any of this exists. A
   * deployment that cannot honour a sign-in must say so, rather than sending
   * someone out through Google's consent screen to arrive back at nothing.
   */
  describe('what stops a sign-in', () => {
    it('refuses to offer a sign-in the deployment cannot honour', async () => {
      auth0Configured = false

      mount()

      const callout = await screen.findByRole('alert')
      expect(callout).toHaveTextContent(/VITE_AUTH0_DOMAIN/i)
      expect(screen.queryByRole('button', { name: /google/i })).not.toBeInTheDocument()
    })

    it('names nothing that is no longer part of the answer', async () => {
      // The secret this used to blame does not exist any more, and neither does
      // the endpoint that reported on it. A message naming either would send
      // whoever deployed the site looking for something that is not there.
      auth0Configured = false

      mount()

      const callout = await screen.findByRole('alert')
      expect(callout).not.toHaveTextContent('SUPABASE_JWT_SECRET')
      expect(callout).not.toHaveTextContent('/api/session')
    })

    it('draws the button without waiting on anyone once the bundle has a tenant', () => {
      // Synchronously, on the first render: there is nothing left to ask, and a
      // spinner in front of a decision already made is a frame of nothing.
      mount()

      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
    })
  })

  /**
   * Both of these used to print the same paragraph, naming two environment
   * variables and a migration. Only one was ever the problem, and the reader had
   * no way to tell which — so the screen reliably sent whoever deployed the site
   * to go and re-check something that was already correct.
   */
  describe('what it says is wrong about Drive', () => {
    async function blockedBy(problem: string): Promise<HTMLElement> {
      authState.status = 'signed-in'
      loadConnectionStatus.mockResolvedValue({ durable: false, connected: false, problem })
      mount()
      return await screen.findByRole('alert')
    }

    it('offers a reload for a server that did not answer, not a verdict on the setup', async () => {
      const callout = await blockedBy('unreachable')

      expect(callout).toHaveTextContent(/reload/i)
      expect(callout).not.toHaveTextContent(/not set up/i)
    })

    it('names the Token Vault credentials, and only those, when they are the gap', async () => {
      const callout = await blockedBy('not-configured')

      expect(callout).toHaveTextContent('AUTH0_BACKEND_CLIENT_ID')
      expect(callout).toHaveTextContent('AUTH0_BACKEND_CLIENT_SECRET')
      expect(callout).not.toHaveTextContent(/SUPABASE_SERVICE_ROLE_KEY/)
    })
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
