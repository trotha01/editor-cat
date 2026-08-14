import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * Who gets into the editor.
 *
 * One requirement now, where there were three. A session used to be the first
 * of a Drive grant and a folder to write into, and each was its own screen
 * because each came from somewhere else — Auth0 signed the user in, Google
 * granted Drive afterwards, and the folder was ours to ask about. Media lives
 * in our own storage now, so the gate is a gate again rather than a queue.
 *
 * What still matters, and is invisible from the outside: an unconfigured build
 * must not gate at all, or mock mode and a fresh clone would both be locked out
 * of their own editor.
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

let signInRequired = true

vi.mock('../state/useAuthStore', () => ({
  requiresSignIn: () => signInRequired,
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}))

let auth0Configured = true

vi.mock('../lib/auth0/client', () => ({
  isAuth0Configured: () => auth0Configured,
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
  auth0Configured = true
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
  it('offers a sign-in', async () => {
    mount()

    expect(await screen.findByRole('button', { name: /sign in with google/i })).toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('asks for nothing beyond signing in', async () => {
    // The whole point of removing Drive: no second consent, no folder to
    // choose, and no grant that can lapse and lock somebody out of their own
    // editor an hour later.
    mount()
    await screen.findByRole('button', { name: /sign in with google/i })

    expect(screen.queryByText(/drive/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/folder/i)).not.toBeInTheDocument()
  })

  it('starts the session check on mount', () => {
    mount()
    expect(authState.start).toHaveBeenCalled()
  })

  it('shows nothing while a stored session is being read back', () => {
    // Neither of these should flash a sign-in screen at somebody who is about
    // to be let straight through, or who is already on their way to Google.
    authState.status = 'checking'
    mount()
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
    expect(screen.queryByText(EDITOR)).not.toBeInTheDocument()
  })

  it('shows nothing while the browser is on its way to Google', () => {
    authState.status = 'signing-in'
    mount()
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
  })

  describe('what stops a sign-in', () => {
    it('reports a failed attempt', async () => {
      authState.error = 'Something went wrong'
      mount()

      expect(await screen.findByText('Something went wrong')).toBeInTheDocument()
    })

    it('names the variables a build without a tenant is missing', async () => {
      // An operator problem, and one no visitor can do anything about, so it
      // says so rather than offering a button that cannot work.
      auth0Configured = false
      mount()

      expect(await screen.findByText(/not set up for sign-in/i)).toBeInTheDocument()
      expect(screen.getByText('VITE_AUTH0_DOMAIN')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /sign in with google/i })).not.toBeInTheDocument()
    })
  })
})

describe('once inside', () => {
  it('opens the editor for a signed-in visitor', () => {
    authState.status = 'signed-in'

    mount()

    expect(screen.getByText(EDITOR)).toBeInTheDocument()
  })
})
