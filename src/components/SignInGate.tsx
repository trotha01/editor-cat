/**
 * The sign-in screen, shown instead of the editor when a session is required.
 *
 * Only stands in the way when this build actually has a Supabase project behind
 * it (see `requiresSignIn`). Mock mode and an unconfigured checkout render the
 * editor directly, which is what keeps the end-to-end test and a fresh clone
 * working with no account at all.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Callout, Spinner } from './ui'
import { createNonce, renderSignInButton, type Nonce } from '../lib/google/identity'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'

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

function SignInScreen({ busy }: { busy: boolean }) {
  const signIn = useAuthStore((state) => state.signIn)
  const error = useAuthStore((state) => state.error)
  const setError = useAuthStore((state) => state.setError)

  const buttonRef = useRef<HTMLDivElement>(null)
  const [nonce, setNonce] = useState<Nonce | null>(null)

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

        {busy ? (
          <span className="flex items-center gap-2 text-sm text-ink-dim">
            <Spinner /> Signing in…
          </span>
        ) : (
          // Google's own button, required by their branding terms and the only
          // reliable entry point — One Tap gets suppressed after a few
          // dismissals, which would leave no way in at all.
          <div ref={buttonRef} className="flex min-h-11 justify-center" />
        )}

        <p className="text-xs leading-relaxed text-ink-dim">
          The same Google account is used to save media to Drive. Your API keys stay in this browser
          and are never part of your account.
        </p>
      </div>
    </div>
  )
}
