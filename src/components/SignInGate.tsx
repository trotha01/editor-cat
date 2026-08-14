/**
 * The way in.
 *
 * One thing has to be true before the editor opens: a session. It used to be
 * three — a session, permission to write to the user's Drive, and a folder to
 * write into — and the middle one could not even ride along on the login, since
 * Auth0 files a scope granted at sign-in against the user's *identity* while
 * Token Vault reads `connected_accounts`, which only the separate connect flow
 * writes. So it was a second trip to Google, and then a third screen to choose
 * where files went.
 *
 * Media lives in our own storage now, so all of that is gone: no second
 * consent, no folder to pick, no grant that can lapse and lock somebody out of
 * their own editor. Google is still how you sign in; it is no longer something
 * this app asks anything else of.
 *
 * Only stands in the way when this build actually has a Supabase project behind
 * it (see `requiresSignIn`). Mock mode and an unconfigured checkout render the
 * editor directly, which is what keeps the end-to-end test and a fresh clone
 * working with no account at all.
 */
import { useEffect, type ReactNode } from 'react'
import { Callout, Spinner } from './ui'
import { isAuth0Configured } from '../lib/auth0/client'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'

export function SignInGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status)
  const start = useAuthStore((state) => state.start)

  useEffect(() => {
    void start()
  }, [start])

  if (!requiresSignIn() || status === 'signed-in') return <>{children}</>

  // 'checking' is the stored session being read back and 'signing-in' is the
  // browser on its way to Google. Neither should flash a screen at someone who
  // is about to be let straight through, or who is already leaving.
  if (status === 'checking' || status === 'signing-in') return <Loading />

  return <SignInScreen />
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas text-ink">
      <Spinner />
    </div>
  )
}

/** The card every gate screen sits in, so they cannot drift apart. */
function Panel({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6 text-ink">
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-xl border border-line bg-surface p-8 text-center">
        <span aria-hidden className="text-4xl">
          🎬
        </span>
        <div>
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">{lead}</p>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Why this deployment cannot sign anyone in.
 *
 * This used to be a question for the server, asked over `GET /api/session`
 * before the button was drawn, because the half that could be missing was a
 * signing secret only the functions could see. There is no such secret now —
 * Supabase validates the Auth0 token itself — and with it went the only reason
 * to ask anyone anything. What is left is `VITE_AUTH0_*`, which is compiled into
 * this bundle, so the check is a function call and the answer is available on
 * the first render rather than a round trip later.
 *
 * The Supabase half needs no check here at all: `requiresSignIn` is what puts
 * this screen on the page, and it is false without a project URL and anon key.
 * A deployment missing those does not show a broken sign-in, it opens the editor
 * in local-only mode, which is a different screen and the right one.
 *
 * What genuinely cannot be checked from here is whether the Supabase project has
 * Auth0 registered as a third-party auth provider, and whether the tenant's
 * Login Action sets `role: authenticated`. Both live in dashboards, neither is
 * visible to a browser before a token exists, and getting either wrong shows up
 * as an empty project list rather than a refused sign-in. The README says so
 * next to the steps.
 */
function SignInProblem() {
  return (
    <Callout tone="error" title="This site is not set up for sign-in">
      It was built without <code>VITE_AUTH0_DOMAIN</code>, <code>VITE_AUTH0_CLIENT_ID</code> and{' '}
      <code>VITE_AUTH0_AUDIENCE</code>, so there is no tenant to sign in against. Nothing you can
      fix from here.
    </Callout>
  )
}

function SignInScreen() {
  const signIn = useAuthStore((state) => state.signIn)
  const error = useAuthStore((state) => state.error)

  return (
    <Panel
      title="editor-cat"
      lead="Sign in to keep your projects. Your timelines and your media are saved to your account, so they are there on any machine you sign in on."
    >
      {error ? (
        <Callout tone="error" title="Sign-in failed">
          {error}
        </Callout>
      ) : null}

      {isAuth0Configured() ? (
        <GoogleButton onClick={signIn} label="Sign in with Google" />
      ) : (
        <SignInProblem />
      )}

      <p className="text-xs leading-relaxed text-ink-dim">
        Signing in tells us who you are, and that is all it asks for — no access to your Google
        account beyond your name and address. There are no API keys to enter either: everything the
        editor generates runs on this site&apos;s own accounts.
      </p>
    </Panel>
  )
}

/**
 * Google's sign-in button, drawn to their branding terms.
 *
 * Ours rather than `google.accounts.id.renderButton`, which needs Google's own
 * script on the page — and the CSP has no reason to allow one any more.
 *
 * The literal colours are Google's light-theme values, which their terms fix —
 * they are not ours to pull from the theme.
 */
function GoogleButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 items-center gap-3 rounded-full border border-[#747775] bg-white pl-3 pr-4 text-sm font-medium text-[#1f1f1f] transition hover:bg-[#f2f2f2] disabled:opacity-50"
    >
      <GoogleMark />
      {label}
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
