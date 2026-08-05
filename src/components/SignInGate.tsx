/**
 * The sign-in screen, shown instead of the editor when a session is required.
 *
 * Only stands in the way when this build actually has a Supabase project behind
 * it (see `requiresSignIn`). Mock mode and an unconfigured checkout render the
 * editor directly, which is what keeps the end-to-end test and a fresh clone
 * working with no account at all.
 *
 * Signing in also authorises Google Drive, from the same consent screen — one
 * decision rather than two, and no separate connection step in Settings. Where
 * the deployment cannot store a Drive connection there is nothing to authorise
 * here, so it falls back to Google's own identity-only button.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Callout, Spinner } from './ui'
import { createNonce, renderSignInButton, requestSignIn, type Nonce } from '../lib/google/identity'
import { ConsentDeclinedError } from '../lib/google/oauthPopup'
import { loadConnectionStatus } from '../lib/google/gis'
import { toDisplayMessage } from '../lib/errors'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'
import { useDriveStore } from '../state/useDriveStore'

export function SignInGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status)
  const start = useAuthStore((state) => state.start)

  useEffect(() => {
    // `start` resolves after the effect may already have been torn down —
    // StrictMode mounts twice in development — so the unsubscribe has to be
    // callable late. Without the flag the first subscription is never dropped
    // and every auth change is handled twice.
    let cancelled = false
    let dispose: (() => void) | undefined

    void start().then((unsubscribe) => {
      if (cancelled) unsubscribe()
      else dispose = unsubscribe
    })

    return () => {
      cancelled = true
      dispose?.()
    }
  }, [start])

  if (!requiresSignIn() || status === 'signed-in') return <>{children}</>

  if (status === 'checking') {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-ink">
        <Spinner />
      </div>
    )
  }

  return <SignInScreen busy={status === 'signing-in'} />
}

/** Which sign-in this deployment can offer. `null` until the check answers. */
type Mode = 'combined' | 'identity-only' | null

function SignInScreen({ busy }: { busy: boolean }) {
  const signIn = useAuthStore((state) => state.signIn)
  const error = useAuthStore((state) => state.error)
  const setError = useAuthStore((state) => state.setError)

  const [nonce, setNonce] = useState<Nonce | null>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [opening, setOpening] = useState(false)

  // One nonce per mounted screen: Google signs its hash into the token and
  // Supabase re-hashes the raw value to match, so a token cannot be replayed.
  useEffect(() => {
    let cancelled = false
    createNonce().then(
      (value) => {
        if (!cancelled) setNonce(value)
      },
      () => {
        if (!cancelled) setError('This browser cannot generate a secure sign-in token.')
      },
    )
    return () => {
      cancelled = true
    }
  }, [setError])

  // Whether Drive can come with the sign-in is a property of the deployment, so
  // it is settled before the button is drawn rather than discovered mid-flow.
  // The answer is cached for the session, which also saves `restore` a call.
  useEffect(() => {
    let cancelled = false
    void loadConnectionStatus().then(({ durable }) => {
      if (!cancelled) setMode(durable ? 'combined' : 'identity-only')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const signInWithDrive = useCallback(async () => {
    if (!nonce) return
    setError(null)
    setOpening(true)
    try {
      const { idToken, code } = await requestSignIn(nonce)
      // Claimed before the session exists, so the `restore` that runs the moment
      // the editor mounts leaves this connection alone.
      useDriveStore.getState().setConnecting(true)

      // `signIn` reports its own failure rather than throwing, and a code
      // cannot be filed under an account that was never created — so the claim
      // is released rather than left hanging on a sign-in that did not happen.
      await signIn(idToken, nonce.raw)
      if (useAuthStore.getState().status !== 'signed-in') {
        useDriveStore.getState().setConnecting(false)
        return
      }

      await useDriveStore.getState().adopt(code)
    } catch (cause) {
      useDriveStore.getState().setConnecting(false)
      // Closing the window is a decision, not a failure — no error banner for it.
      if (!(cause instanceof ConsentDeclinedError)) setError(toDisplayMessage(cause))
    } finally {
      setOpening(false)
    }
  }, [nonce, signIn, setError])

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-line bg-surface p-8 text-center">
        <span aria-hidden className="text-4xl">
          🎬
        </span>
        <div>
          <h1 className="text-lg font-semibold">editor-cat</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">
            Sign in to keep your projects. Your timelines are saved to your account, and your media
            to your own Google Drive.
          </p>
        </div>

        {error ? (
          <Callout tone="error" title="Sign-in failed">
            {error}
          </Callout>
        ) : null}

        {busy || opening ? (
          <span className="flex items-center gap-2 text-sm text-ink-dim">
            <Spinner /> Signing in…
          </span>
        ) : mode === 'combined' ? (
          <GoogleButton onClick={() => void signInWithDrive()} disabled={!nonce} />
        ) : mode === 'identity-only' ? (
          <IdentityOnlyButton nonce={nonce} />
        ) : (
          <Spinner />
        )}

        <p className="text-xs leading-relaxed text-ink-dim">
          {mode === 'identity-only'
            ? 'Saving media to Drive is a separate step, in Settings. Your API keys stay in this browser and are never part of your account.'
            : 'The same permission saves your media to a folder you pick in your own Drive. Your API keys stay in this browser and are never part of your account.'}
        </p>
      </div>
    </div>
  )
}

/**
 * Google's sign-in button, drawn to their branding terms.
 *
 * Rendered here rather than by `google.accounts.id.renderButton`, because that
 * button is welded to the identity-only flow and cannot ask for Drive.
 */
function GoogleButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-10 items-center gap-3 rounded-full border border-[#8e918f] bg-[#131314] pl-3 pr-4 text-sm font-medium text-[#e3e3e3] transition hover:bg-[#1c1c1d] disabled:opacity-50"
    >
      <GoogleMark />
      Sign in with Google
    </button>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.59-5.17 3.59-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3c-1.08.72-2.45 1.16-4.08 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.24-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29A11.99 11.99 0 0 0 0 12c0 1.94.46 3.77 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  )
}

/**
 * The fallback for a deployment that cannot store a Drive connection.
 *
 * Google's own rendered button, which is required by their branding terms for
 * this flow and is the only reliable entry point — One Tap gets suppressed after
 * a few dismissals, which would leave no way in at all.
 */
function IdentityOnlyButton({ nonce }: { nonce: Nonce | null }) {
  const signIn = useAuthStore((state) => state.signIn)
  const setError = useAuthStore((state) => state.setError)
  const buttonRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = buttonRef.current
    if (!container || !nonce) return

    let dispose: (() => void) | undefined
    void renderSignInButton(
      container,
      nonce,
      (idToken) => void signIn(idToken, nonce.raw),
      (message) => setError(message),
    ).then((cleanup) => {
      dispose = cleanup
    })

    return () => dispose?.()
  }, [nonce, signIn, setError])

  return <div ref={buttonRef} className="flex min-h-11 justify-center" />
}
