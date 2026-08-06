/**
 * The way in, and the only place this app asks anyone for Google.
 *
 * Three things have to be true before the editor opens, and the gate holds all
 * of them: a session, permission to write to the user's Drive, and a folder to
 * write into. The first two come from one Google consent screen; the third is a
 * step of our own, because an editor that silently saves nowhere is worse than
 * one more click.
 *
 * Only stands in the way when this build actually has a Supabase project behind
 * it (see `requiresSignIn`). Mock mode and an unconfigured checkout render the
 * editor directly, which is what keeps the end-to-end test and a fresh clone
 * working with no account at all.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Callout, Spinner } from './ui'
import { createNonce, requestSignIn, type Nonce } from '../lib/google/identity'
import { ConsentDeclinedError } from '../lib/google/oauthPopup'
import { isDriveConfigured, loadConnectionStatus } from '../lib/google/gis'
import type { StatusProblem } from '../lib/google/connection'
import { createFolder } from '../lib/google/drive'
import { isPickerConfigured, pickFolder } from '../lib/google/picker'
import { toDisplayMessage } from '../lib/errors'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'
import { useDriveStore } from '../state/useDriveStore'

export function SignInGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status)
  const start = useAuthStore((state) => state.start)
  const driveStatus = useDriveStore((state) => state.status)
  const folder = useDriveStore((state) => state.folder)

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

  // Restoring Drive belongs here rather than in the editor: the editor does not
  // mount until it has succeeded, so it could not be the thing that starts it.
  useEffect(() => {
    if (status !== 'signed-in') return
    void useDriveStore.getState().restore()
  }, [status])

  const ready = driveStatus === 'connected' && folder !== null

  /**
   * Whether the editor has been reached this session.
   *
   * Latched on purpose. All three requirements are for getting *in*; a grant
   * revoked from someone's Google account page an hour later must not throw them
   * out of an open project — the editor reports that instead. Setting state
   * during render is React's own answer to deriving from a store value without a
   * wasted pass, and avoids a frame of sign-in screen after connecting.
   */
  const [entered, setEntered] = useState(false)
  if (!entered && ready) setEntered(true)

  if (!requiresSignIn() || entered) return <>{children}</>

  // 'checking' is the stored session being read back; 'connecting' is its Drive
  // connection being resumed. Neither should flash a screen at someone who is
  // about to be let straight through.
  if (status === 'checking' || driveStatus === 'connecting') {
    return (
      <div className="flex h-full items-center justify-center bg-canvas text-ink">
        <Spinner />
      </div>
    )
  }

  // Everything Google asks for is done; all that is left is where to put things.
  if (driveStatus === 'connected') return <ChooseFolderStep />

  return <SignInScreen busy={status === 'signing-in'} hasSession={status === 'signed-in'} />
}

/** The name given to the folder this app offers to make for you. */
const DEFAULT_FOLDER_NAME = 'editor-cat'

/**
 * The last step before the editor: where new media is saved.
 *
 * Offered as a choice rather than done silently, because it is the user's Drive
 * and they should know which corner of it this app is writing to. Making one for
 * them is the primary action all the same — most people have no existing folder
 * in mind, and hunting for one through the Picker to answer a question they did
 * not ask is a poor first minute.
 */
function ChooseFolderStep() {
  const setFolder = useDriveStore((state) => state.setFolder)

  const [busy, setBusy] = useState<'creating' | 'choosing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'creating' | 'choosing') => {
    setBusy(kind)
    setError(null)
    try {
      const folder =
        kind === 'creating' ? await createFolder(DEFAULT_FOLDER_NAME) : await pickFolder()
      // A cancelled Picker resolves to null, which is not a failure — the step
      // simply stays put.
      if (folder) setFolder(folder)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel
      title="Where should your media go?"
      lead={`Generated images, rendered clips and recordings are copied into a folder in your own Google Drive as you make them. Pick one, or let ${DEFAULT_FOLDER_NAME} make its own.`}
    >
      {error ? (
        <Callout tone="error" title="Could not set that folder">
          {error}
        </Callout>
      ) : null}

      {busy ? (
        <span className="flex items-center gap-2 text-sm text-ink-dim">
          <Spinner /> {busy === 'creating' ? 'Creating the folder…' : 'Waiting for your choice…'}
        </span>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" onClick={() => void run('creating')}>
            Create an “{DEFAULT_FOLDER_NAME}” folder
          </Button>
          {/* Creating a folder is a plain Drive call, but choosing one needs the
              Picker — so on a deployment without an API key, offer only the half
              that can work rather than a button that always fails. */}
          {isPickerConfigured() ? (
            <Button onClick={() => void run('choosing')}>Choose an existing folder</Button>
          ) : null}
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-dim">
        You can change this later in Settings. This site only ever sees the folder you point it at
        and the files it puts there.
      </p>
    </Panel>
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
 * What this deployment can offer. `null` until the config check answers.
 *
 * `no-client-id` is this side's own contribution: the function can be perfectly
 * configured while the bundle was built without a Google client to sign in
 * against, and only the bundle knows that.
 */
type Readiness = 'ready' | 'no-client-id' | StatusProblem | null

/**
 * What to say about a deployment that cannot sign anyone in.
 *
 * These four causes shared one message once, naming two environment variables
 * and a migration. Whoever read it could not tell which of the three was
 * actually missing, and the two it named first were usually the ones already
 * set — so the message sent people to re-check correct configuration while the
 * real gap went unmentioned.
 */
function SetupProblem({ problem }: { problem: Exclude<Readiness, 'ready' | null> }) {
  if (problem === 'unreachable') {
    return (
      <Callout tone="error" title="Cannot reach this site's server">
        Signing in needs an answer from it, and it did not give one. This is usually temporary —
        reload to try again.
      </Callout>
    )
  }

  if (problem === 'no-table') {
    return (
      <Callout tone="error" title="This site is not finished being set up">
        Its database has no <code>google_connections</code> table, so there is nowhere to keep the
        Drive connection. Whoever deployed it needs to run{' '}
        <code>supabase/migrations/0002_google_connections.sql</code>. Nothing you can fix from here.
      </Callout>
    )
  }

  if (problem === 'no-client-id') {
    return (
      <Callout tone="error" title="This site is not set up for sign-in">
        It was built without <code>VITE_GOOGLE_CLIENT_ID</code>, so there is no Google client to
        sign in against. Nothing you can fix from here.
      </Callout>
    )
  }

  return (
    <Callout tone="error" title="This site is not set up for sign-in">
      Whoever deployed it needs to set <code>GOOGLE_CLIENT_SECRET</code> and{' '}
      <code>SUPABASE_SERVICE_ROLE_KEY</code> in the site environment. Nothing you can fix from here.
    </Callout>
  )
}

function SignInScreen({ busy, hasSession }: { busy: boolean; hasSession: boolean }) {
  const signIn = useAuthStore((state) => state.signIn)
  const error = useAuthStore((state) => state.error)
  const setError = useAuthStore((state) => state.setError)
  const driveError = useDriveStore((state) => state.error)

  const [nonce, setNonce] = useState<Nonce | null>(null)
  const [readiness, setReadiness] = useState<Readiness>(null)
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

  // Sign-in hands its consent code to a function that needs a client secret to
  // exchange it, so a deployment missing that cannot sign anyone in. Settled
  // before the button is drawn: better to say so than to send someone through
  // Google's consent screen and fail afterwards.
  useEffect(() => {
    let cancelled = false
    void loadConnectionStatus().then(({ durable, problem }) => {
      if (cancelled) return
      // Checked first: without a client id there is nothing to sign in against,
      // however well the server half is configured.
      if (!isDriveConfigured()) setReadiness('no-client-id')
      else setReadiness(durable ? 'ready' : (problem ?? 'not-configured'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const start = useCallback(async () => {
    if (!nonce) return
    setError(null)
    setOpening(true)
    try {
      const { idToken, code } = await requestSignIn(nonce)
      // Claimed before the session exists, so the `restore` that runs the moment
      // there is one leaves this connection alone.
      useDriveStore.getState().setConnecting(true)

      // `signIn` reports its own failure rather than throwing, and a code cannot
      // be filed under an account that was never created — so the claim is
      // released rather than left hanging on a sign-in that did not happen.
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

  // A session with no Drive behind it: the permission was unticked on Google's
  // screen, or this account signed in before the app started asking for both.
  const needsDrive = hasSession && readiness === 'ready'

  return (
    <Panel
      title="editor-cat"
      lead={
        needsDrive
          ? 'Almost there — the editor saves your media to your own Google Drive, so it needs your permission to write there.'
          : 'Sign in to keep your projects. Your timelines are saved to your account, and your media to a folder in your own Google Drive.'
      }
    >
      {error ? (
        <Callout tone="error" title="Sign-in failed">
          {error}
        </Callout>
      ) : null}

      {needsDrive && driveError ? (
        <Callout tone="error" title="Google Drive access is needed">
          {driveError}
        </Callout>
      ) : null}

      {readiness !== null && readiness !== 'ready' ? (
        <SetupProblem problem={readiness} />
      ) : busy || opening ? (
        <span className="flex items-center gap-2 text-sm text-ink-dim">
          <Spinner /> Signing in…
        </span>
      ) : readiness === 'ready' ? (
        <GoogleButton
          onClick={() => void start()}
          disabled={!nonce}
          label={needsDrive ? 'Allow Google Drive' : 'Sign in with Google'}
        />
      ) : (
        <Spinner />
      )}

      {needsDrive && !busy && !opening ? (
        // Without this, unticking Drive strands a perfectly good session on a
        // screen whose only button will not help.
        <button
          type="button"
          onClick={() => {
            useDriveStore.getState().forget()
            void useAuthStore.getState().signOut()
          }}
          className="text-xs text-ink-dim underline"
        >
          Use a different account
        </button>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-dim">
        One permission covers both: it signs you in, and it lets the editor save your media to a
        folder you pick. Your API keys stay in this browser and are never part of your account.
      </p>
    </Panel>
  )
}

/**
 * Google's sign-in button, drawn to their branding terms.
 *
 * Ours rather than `google.accounts.id.renderButton`, because that button is
 * welded to the identity-only flow and cannot ask for Drive.
 */
function GoogleButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void
  disabled: boolean
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-10 items-center gap-3 rounded-full border border-[#8e918f] bg-[#131314] pl-3 pr-4 text-sm font-medium text-[#e3e3e3] transition hover:bg-[#1c1c1d] disabled:opacity-50"
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
