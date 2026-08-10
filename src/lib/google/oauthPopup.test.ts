import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationUrl,
  callbackUri,
  CALLBACK_MESSAGE,
  ConsentDeclinedError,
  requestAuthorization,
  type CallbackMessage,
} from './oauthPopup'
import { completeOauthCallback, isOauthCallback } from './oauthCallback'

const CLIENT_ID = 'client-abc.apps.googleusercontent.com'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

describe('authorizationUrl', () => {
  const url = (extra: Record<string, string> = {}) =>
    new URL(authorizationUrl({ clientId: CLIENT_ID, scope: SCOPE, ...extra }, 'state-1'))

  it('asks for offline access, which is what produces a refresh token at all', () => {
    expect(url().searchParams.get('access_type')).toBe('offline')
  })

  it('forces the consent screen, so a returning user gets a refresh token too', () => {
    // Without this the exchange succeeds for anyone who has granted these scopes
    // before and quietly returns no refresh token — a connection that once again
    // dies after an hour, which is the bug this whole path exists to fix.
    expect(url().searchParams.get('prompt')).toBe('consent')
  })

  it('uses the code flow against Google’s auth endpoint', () => {
    expect(url().origin + url().pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url().searchParams.get('response_type')).toBe('code')
    expect(url().searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url().searchParams.get('scope')).toBe(SCOPE)
  })

  it('points back at this origin, which the exchange has to reproduce exactly', () => {
    expect(url().searchParams.get('redirect_uri')).toBe(`${window.location.origin}/oauth/google`)
    expect(callbackUri()).toBe(`${window.location.origin}/oauth/google`)
  })

  it('carries a state value, so a stale pop-up cannot answer a later request', () => {
    expect(url().searchParams.get('state')).toBe('state-1')
  })

  it('passes the signed-in address as a hint, so Google skips the account picker', () => {
    // Sign-in and Drive are two screens now that Netlify Identity owns the
    // login. This is what keeps them from being two *questions*.
    expect(url({ loginHint: 'someone@example.com' }).searchParams.get('login_hint')).toBe(
      'someone@example.com',
    )
  })

  it('asks for a bare code, never an ID token', () => {
    // Nothing reads one any more: identity comes from Netlify Identity, and a
    // token in the fragment would only be something else to keep out of a log.
    expect(url().searchParams.get('response_type')).toBe('code')
    expect(url().searchParams.has('nonce')).toBe(false)
    expect(url().searchParams.has('login_hint')).toBe(false)
  })

  it('lets the caller widen the prompt, for picking an account at sign-in', () => {
    expect(url({ prompt: 'select_account consent' }).searchParams.get('prompt')).toBe(
      'select_account consent',
    )
  })
})

/** A stand-in for the pop-up window, which jsdom will not open for real. */
function fakePopup() {
  return { closed: false, close: vi.fn(), location: { href: '' } }
}

function reply(message: Partial<CallbackMessage>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: CALLBACK_MESSAGE, ...message },
    }),
  )
}

describe('requestAuthorization', () => {
  let popup: ReturnType<typeof fakePopup>
  let open: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    popup = fakePopup()
    open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'state-1' as ReturnType<typeof crypto.randomUUID>,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the window before awaiting anything, so the click still counts', () => {
    void requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE }).catch(() => {})

    // A pop-up opened after an await is attributed to no gesture and blocked.
    expect(open).toHaveBeenCalledOnce()
    expect(String(open.mock.calls[0]?.[0])).toContain('accounts.google.com')

    reply({ state: 'state-1', code: 'code-1' })
  })

  it('resolves with the code the callback window hands back', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
    reply({ state: 'state-1', code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
    expect(popup.close).toHaveBeenCalled()
  })

  it('ignores an answer carrying someone else’s state', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })

    reply({ state: 'a-previous-attempt', code: 'wrong-code' })
    reply({ state: 'state-1', code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
  })

  it('ignores a message from another origin', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { source: CALLBACK_MESSAGE, state: 'state-1', code: 'planted' },
      }),
    )
    reply({ state: 'state-1', code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
  })

  it('treats a declined consent as a decision rather than a fault', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
    reply({ state: 'state-1', error: 'access_denied' })

    await expect(pending).rejects.toBeInstanceOf(ConsentDeclinedError)
  })

  it('notices the window being closed, which fires no event of its own', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
    // Asserted before the timer runs, so the rejection is never momentarily
    // unhandled — which vitest reports as an error in its own right.
    const rejected = expect(pending).rejects.toBeInstanceOf(ConsentDeclinedError)

    popup.closed = true
    await vi.advanceTimersByTimeAsync(500)

    await rejected
  })

  it('explains a blocked pop-up instead of hanging forever', async () => {
    open.mockReturnValue(null)

    await expect(requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })).rejects.toThrow(
      /Allow pop-ups/,
    )
  })
})

/** jsdom leaves `window.opener` undefined, so it has to be installed to be faked. */
function withOpener(opener: { postMessage: (data: unknown, origin: string) => void } | null): void {
  Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true })
}

describe('the callback window', () => {
  const original = window.location.pathname

  afterEach(() => {
    window.history.replaceState({}, '', original)
    delete (window as { opener?: unknown }).opener
    vi.restoreAllMocks()
  })

  it('recognises itself by path, so the editor never mounts there', () => {
    window.history.replaceState({}, '', '/oauth/google?code=code-1&state=state-1')
    expect(isOauthCallback()).toBe(true)

    window.history.replaceState({}, '', '/')
    expect(isOauthCallback()).toBe(false)
  })

  it('hands the code to its opener and closes, targeting this origin only', () => {
    window.history.replaceState({}, '', '/oauth/google?code=code-1&state=state-1')

    const postMessage = vi.fn()
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    withOpener({ postMessage })

    completeOauthCallback()

    expect(postMessage).toHaveBeenCalledWith(
      { source: CALLBACK_MESSAGE, state: 'state-1', code: 'code-1' },
      window.location.origin,
    )
    expect(close).toHaveBeenCalled()
  })

  it('reads an answer out of the fragment too, wherever Google chose to put it', () => {
    // The code flow answers in the query string. Reading the fragment as well
    // costs one line and means a redirect that ever came back that way is not
    // mistaken for a consent that returned nothing.
    window.history.replaceState({}, '', '/oauth/google#code=code-1&state=state-1')

    const postMessage = vi.fn()
    vi.spyOn(window, 'close').mockImplementation(() => {})
    withOpener({ postMessage })

    completeOauthCallback()

    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      source: CALLBACK_MESSAGE,
      state: 'state-1',
      code: 'code-1',
    })
  })

  it('passes a refusal along, so the opener can tell it apart from a crash', () => {
    window.history.replaceState({}, '', '/oauth/google?error=access_denied&state=state-1')

    const postMessage = vi.fn()
    vi.spyOn(window, 'close').mockImplementation(() => {})
    withOpener({ postMessage })

    completeOauthCallback()

    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      source: CALLBACK_MESSAGE,
      state: 'state-1',
      error: 'access_denied',
    })
  })

  it('says something useful when opened directly, with nobody to answer', () => {
    window.history.replaceState({}, '', '/oauth/google?code=code-1&state=state-1')
    withOpener(null)

    completeOauthCallback()

    expect(document.body.textContent).toContain('close this window')
  })
})
