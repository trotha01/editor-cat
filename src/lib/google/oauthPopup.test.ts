import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authorizationUrl,
  callbackOrigin,
  callbackUri,
  CALLBACK_MESSAGE,
  ConsentDeclinedError,
  openerOrigin,
  requestAuthorization,
  type CallbackMessage,
} from './oauthPopup'
import { completeOauthCallback, isAllowedOpenerOrigin, isOauthCallback } from './oauthCallback'

const CLIENT_ID = 'client-abc.apps.googleusercontent.com'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** The registered origin a multi-deploy site points every consent screen at. */
const SHARED = 'https://staging.example.com'
const SUFFIX = '.staging.example.com'
const PREVIEW = 'https://deploy-preview-28.staging.example.com'

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

  it('points every deploy at one registered origin when the site has several', () => {
    // Google takes no wildcard in a redirect URI, so a deploy preview can never
    // have an entry of its own. Sending them all to one registered origin is
    // what lets a single console entry cover every preview there will ever be.
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ORIGIN', SHARED)

    expect(callbackUri()).toBe(`${SHARED}/oauth/google`)
    expect(url().searchParams.get('redirect_uri')).toBe(`${SHARED}/oauth/google`)

    vi.unstubAllEnvs()
  })

  it('tolerates a trailing slash on the configured origin, which Google would not', () => {
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ORIGIN', `${SHARED}/`)
    expect(callbackUri()).toBe(`${SHARED}/oauth/google`)
    vi.unstubAllEnvs()
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

/**
 * What `requestAuthorization` sends now: the nonce, and where to answer.
 *
 * The callback window is served by whichever deploy owns the registered origin,
 * so `state` is the only thing that can tell it where the opener is.
 */
const STATE = `state-1:${window.location.origin}`

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

    reply({ state: STATE, code: 'code-1' })
  })

  it('resolves with the code the callback window hands back', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
    reply({ state: STATE, code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
    expect(popup.close).toHaveBeenCalled()
  })

  it('ignores an answer carrying someone else’s state', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })

    reply({ state: 'a-previous-attempt', code: 'wrong-code' })
    reply({ state: STATE, code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
  })

  it('ignores a message from another origin', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: { source: CALLBACK_MESSAGE, state: STATE, code: 'planted' },
      }),
    )
    reply({ state: STATE, code: 'code-1' })

    await expect(pending).resolves.toEqual({ code: 'code-1' })
  })

  it('treats a declined consent as a decision rather than a fault', async () => {
    const pending = requestAuthorization({ clientId: CLIENT_ID, scope: SCOPE })
    reply({ state: STATE, error: 'access_denied' })

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

  it('sends the answer across to the deploy that opened it', () => {
    // The point of the whole arrangement: this window belongs to the registered
    // origin, the opener is a preview, and the code has to get there.
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    window.history.replaceState(
      {},
      '',
      `/oauth/google?code=code-1&state=${encodeURIComponent(`state-1:${PREVIEW}`)}`,
    )

    const postMessage = vi.fn()
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    withOpener({ postMessage })

    completeOauthCallback()

    expect(postMessage).toHaveBeenCalledWith(
      { source: CALLBACK_MESSAGE, state: `state-1:${PREVIEW}`, code: 'code-1' },
      PREVIEW,
    )
    expect(close).toHaveBeenCalled()
  })

  it('sends nothing at all to an origin outside the suffix', () => {
    // `state` is a query parameter, so this is what an attacker writes into a
    // crafted authorisation URL. Nothing but the suffix check stands here.
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    window.history.replaceState(
      {},
      '',
      `/oauth/google?code=code-1&state=${encodeURIComponent('state-1:https://evil.example')}`,
    )

    const postMessage = vi.fn()
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    withOpener({ postMessage })

    completeOauthCallback()

    expect(postMessage).not.toHaveBeenCalled()
    // Left open on purpose: closing it would take the explanation with it.
    expect(close).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('will not send')
  })
})

describe('isAllowedOpenerOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('allows this window’s own origin with nothing configured at all', () => {
    // Which is what a site with one URL and `netlify dev` both run on.
    expect(isAllowedOpenerOrigin(window.location.origin)).toBe(true)
  })

  it('refuses every other origin when no suffix is set', () => {
    // An unset suffix must fail closed. Anything else would mean a site that
    // never opted into cross-deploy answers could still be talked into one.
    expect(isAllowedOpenerOrigin(PREVIEW)).toBe(false)
  })

  it('allows a deploy under the configured suffix, and the suffix itself', () => {
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    expect(isAllowedOpenerOrigin(PREVIEW)).toBe(true)
    expect(isAllowedOpenerOrigin(SHARED)).toBe(true)
  })

  it('reads a suffix written without its leading dot', () => {
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', 'staging.example.com')
    expect(isAllowedOpenerOrigin(PREVIEW)).toBe(true)
  })

  it('refuses a host that merely ends with the suffix text', () => {
    // The bug the leading dot exists to prevent: `not-staging.example.com` is
    // somebody else's domain, and a bare `endsWith` hands them the code.
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    expect(isAllowedOpenerOrigin('https://not-staging.example.com')).toBe(false)
    expect(isAllowedOpenerOrigin('https://staging.example.com.evil.test')).toBe(false)
  })

  it('refuses http, which would hand the code to whoever is on the path', () => {
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    expect(isAllowedOpenerOrigin('http://deploy-preview-28.staging.example.com')).toBe(false)
  })

  it('refuses anything that is not purely an origin', () => {
    // `new URL` happily parses all of these, and `postMessage` would read the
    // origin out of them — so they have to be rejected before it can.
    vi.stubEnv('VITE_GOOGLE_CALLBACK_ALLOWED_SUFFIX', SUFFIX)
    expect(isAllowedOpenerOrigin(`${PREVIEW}/oauth/google`)).toBe(false)
    expect(isAllowedOpenerOrigin('https://user:pass@deploy-preview-28.staging.example.com')).toBe(
      false,
    )
    expect(isAllowedOpenerOrigin('not a url')).toBe(false)
    expect(isAllowedOpenerOrigin('')).toBe(false)
  })
})

describe('openerOrigin', () => {
  it('reads the origin back out of a state value', () => {
    expect(openerOrigin(`state-1:${PREVIEW}`)).toBe(PREVIEW)
  })

  it('splits on the first colon, so the origin’s own scheme survives', () => {
    expect(openerOrigin('state-1:https://host.example:8443')).toBe('https://host.example:8443')
  })

  it('reports no origin for a state that carries only a nonce', () => {
    // A pop-up opened by a build that predates this, whose opener is this same
    // origin — which is exactly what the caller falls back to.
    expect(openerOrigin('state-1')).toBeNull()
    expect(openerOrigin('state-1:')).toBeNull()
  })

  it('is what callbackOrigin pairs with, unset meaning this origin', () => {
    expect(callbackOrigin()).toBe(window.location.origin)
  })
})
