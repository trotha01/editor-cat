/**
 * The way in.
 *
 * Three things have to be true before the editor opens: a session, permission to
 * write to the user's Drive, and a folder to write into. Only two of them are
 * screens. Auth0 asks Google for the account and the Drive scope in one consent,
 * so signing in grants both; the folder is a choice of our own, because an editor
 * that silently saves nowhere is worse than one more click.
 *
 * It was three screens under Netlify Identity, whose login could not carry a
 * Drive scope — the grant had a step of its own, asked again with the address as
 * a hint so Google did not also ask which account. Getting back to one consent is
 * most of why this app is on Auth0.
 *
 * Only stands in the way when this build actually has a Supabase project behind
 * it (see `requiresSignIn`). Mock mode and an unconfigured checkout render the
 * editor directly, which is what keeps the end-to-end test and a fresh clone
 * working with no account at all.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Callout, Spinner } from './ui'
import { loadConnectionStatus } from '../lib/google/gis'
import { createFolder } from '../lib/google/drive'
import { isPickerConfigured, pickFolder } from '../lib/google/picker'
import { isAuth0Configured } from '../lib/auth0/client'
import { sessionReadiness } from '../lib/supabase/session'
import { toDisplayMessage } from '../lib/errors'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'
import { useDriveStore } from '../state/useDriveStore'

export function SignInGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((state) => state.status)
  const start = useAuthStore((state) => state.start)
  const driveStatus = useDriveStore((state) => state.status)
  const driveDurable = useDriveStore((state) => state.durable)
  const folder = useDriveStore((state) => state.folder)

  useEffect(() => {
    void start()
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

  // 'checking' is the stored session being read back and 'signing-in' is the
  // browser on its way to Google. Neither should flash a screen at someone who
  // is about to be let straight through, or who is already leaving.
  if (status === 'checking' || status === 'signing-in') return <Loading />
  if (status !== 'signed-in') return <SignInScreen />

  // The Drive connection being resumed from the account, which most returning
  // visits do without asking for anything.
  //
  // `durable` is still null before the account has been asked, and `restore`
  // runs from an effect — a paint later than this. Without waiting for the
  // answer, a returning visitor whose connection is about to come back is shown
  // a screen asking them to grant it again, for exactly one frame.
  if (driveStatus === 'connecting' || (driveStatus === 'disconnected' && driveDurable === null)) {
    return <Loading />
  }

  // Everything Google asks for is done; all that is left is where to put things.
  if (driveStatus === 'connected') return <ChooseFolderStep />

  // Signed in, but Drive did not come with it — the scope was declined on the
  // consent screen, or the grant was revoked from the Google account page since.
  // There is no second consent to offer any more: the only way to get the scope
  // is the sign-in that carries it.
  return <GrantMissingStep reconnecting={driveStatus === 'needs-reconnect'} />
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas text-ink">
      <Spinner />
    </div>
  )
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
 * Why this deployment cannot sign anyone in. `null` until the checks answer.
 *
 * Two halves have to be in place and they fail for unrelated reasons, so they
 * are reported separately: the bundle has to have been built with Auth0
 * settings, and this site has to be able to turn an Auth0 login into a Supabase
 * session.
 */
type SignInReadiness = 'ready' | 'no-auth0' | 'no-session' | 'session-unreachable' | null

function SignInProblem({ problem }: { problem: Exclude<SignInReadiness, 'ready' | null> }) {
  if (problem === 'no-auth0') {
    return (
      <Callout tone="error" title="This site is not set up for sign-in">
        It was built without <code>VITE_AUTH0_DOMAIN</code>, <code>VITE_AUTH0_CLIENT_ID</code> and{' '}
        <code>VITE_AUTH0_AUDIENCE</code>, so there is no tenant to sign in against. Nothing you can
        fix from here.
      </Callout>
    )
  }

  if (problem === 'no-session') {
    return (
      <Callout tone="error" title="This site is not finished being set up">
        It can sign you in, but it cannot turn that into a session for your projects, because{' '}
        <code>SUPABASE_JWT_SECRET</code> is not set in the site environment. Nothing you can fix
        from here.
      </Callout>
    )
  }

  return (
    <Callout tone="error" title="Cannot reach this site's server">
      Signing in needs an answer from it, and it did not give one. This is usually temporary —
      reload to try again.
    </Callout>
  )
}

function SignInScreen() {
  const signIn = useAuthStore((state) => state.signIn)
  const error = useAuthStore((state) => state.error)

  const [readiness, setReadiness] = useState<SignInReadiness>(null)

  // Settled before the button is drawn: better to say a site cannot sign anyone
  // in than to send someone out to Google and fail them on the way back.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const session = await sessionReadiness()
      if (cancelled) return

      // Auth0 first: without it there is nothing to sign in with, however well
      // the Supabase half is configured.
      if (!isAuth0Configured()) setReadiness('no-auth0')
      else if (session.ready) setReadiness('ready')
      else setReadiness(session.problem === 'unreachable' ? 'session-unreachable' : 'no-session')
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Panel
      title="editor-cat"
      lead="Sign in to keep your projects. Your timelines are saved to your account, and your media to a folder in your own Google Drive."
    >
      {error ? (
        <Callout tone="error" title="Sign-in failed">
          {error}
        </Callout>
      ) : null}

      {readiness === null ? (
        <Spinner />
      ) : readiness === 'ready' ? (
        <GoogleButton onClick={signIn} label="Sign in with Google" />
      ) : (
        <SignInProblem problem={readiness} />
      )}

      <p className="text-xs leading-relaxed text-ink-dim">
        One screen covers both: who you are, and permission to save your media to a folder in your
        own Google Drive. This site only ever sees that folder and the files it puts there. Your API
        keys stay in this browser and are never part of your account.
      </p>
    </Panel>
  )
}

/** What Drive needs from this deployment. `null` until the check answers. */
type DriveReadiness = 'ready' | 'not-configured' | 'unreachable' | null

/**
 * What to say about a deployment that cannot reach Drive.
 *
 * These causes shared one message once, naming two environment variables and a
 * migration. Whoever read it could not tell which was actually missing, and the
 * ones it named first were usually already set — so the message sent people to
 * re-check correct configuration while the real gap went unmentioned.
 */
function DriveProblem({ problem }: { problem: Exclude<DriveReadiness, 'ready' | null> }) {
  if (problem === 'unreachable') {
    return (
      <Callout tone="error" title="Cannot reach this site's server">
        Reaching your Drive needs an answer from it, and it did not give one. This is usually
        temporary — reload to try again.
      </Callout>
    )
  }

  return (
    <Callout tone="error" title="This site is not set up for Google Drive">
      Whoever deployed it needs to set <code>AUTH0_BACKEND_CLIENT_ID</code> and{' '}
      <code>AUTH0_BACKEND_CLIENT_SECRET</code> in the site environment, and turn on Token Vault for
      the Google connection in Auth0. Nothing you can fix from here.
    </Callout>
  )
}

/**
 * Signed in, but without the Drive permission that should have come with it.
 *
 * Not a second consent screen — there is no longer one to offer. The Drive scope
 * rides on the sign-in, so the only way to obtain it is to sign in again, and the
 * two ways to arrive here both end that way: unticking Drive on Google's consent
 * screen, and revoking it from the Google account page afterwards.
 */
function GrantMissingStep({ reconnecting }: { reconnecting: boolean }) {
  const account = useAuthStore((state) => state.account)
  const driveError = useDriveStore((state) => state.error)

  const [readiness, setReadiness] = useState<DriveReadiness>(null)

  // Settled before the button is drawn, for the same reason as on the sign-in
  // screen: better to say a site cannot reach Drive than to send someone back
  // through Google and fail them on the way in.
  useEffect(() => {
    let cancelled = false
    void loadConnectionStatus().then(({ durable, problem }) => {
      if (cancelled) return
      setReadiness(durable ? 'ready' : (problem ?? 'not-configured'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const again = () => {
    useDriveStore.getState().forget()
    void useAuthStore.getState().signOut()
  }

  return (
    <Panel
      title={reconnecting ? 'Reconnect Google Drive' : 'Google Drive permission is missing'}
      lead={
        reconnecting
          ? 'Your Google Drive access stopped working — revoked, or simply expired. The editor saves your media there, so it needs it back.'
          : 'Signing in is meant to grant Drive at the same time, and this account did not. The editor saves your media to your own Drive, so it cannot open without it.'
      }
    >
      {driveError ? (
        <Callout tone="error" title="Google Drive access is needed">
          {driveError}
        </Callout>
      ) : null}

      {readiness === null ? (
        <Spinner />
      ) : readiness !== 'ready' ? (
        <DriveProblem problem={readiness} />
      ) : (
        <Button variant="primary" onClick={again}>
          Sign in again
        </Button>
      )}

      <p className="text-xs leading-relaxed text-ink-dim">
        {account?.email ? `Signed in as ${account.email}. ` : ''}
        Leave “See, edit, create and delete only the files you use with this app” ticked on Google’s
        screen. This site only ever sees the folder you point it at and the files it puts there.
      </p>
    </Panel>
  )
}

/**
 * Google's sign-in button, drawn to their branding terms.
 *
 * Ours rather than `google.accounts.id.renderButton`, because that button is
 * welded to the identity-only flow and cannot ask for Drive.
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
