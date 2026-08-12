/**
 * The Mintspace half of the export dialog: sign in, caption, publish.
 *
 * Kept out of ExportDialog because it is a second thing entirely. The dialog is
 * about what the file will be — how big, how good, how long; this is about
 * where it goes and who it goes as, and that involves an account the editor
 * does not otherwise know anything about. See lib/mintspace/client.ts for why
 * signing in here is a separate act from being signed in to the editor.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Callout, Field, Spinner, TextArea, TextInput } from './ui'
import { isAbort } from '../lib/errors'
import { isMintspaceConfigured } from '../lib/mintspace/client'
import {
  CAPTION_MAX_LENGTH,
  currentAccount,
  mintspaceErrorMessage,
  publishVideo,
  signIn,
  signOut,
  signUp,
  type MintspaceAccount,
  type PublishedVideo,
} from '../lib/mintspace/publish'

export interface MintspacePublishProps {
  /** Renders the timeline to an MP4 — or hands back one already rendered. */
  render: () => Promise<Blob>
  /** True when there is nothing on the timeline to publish. */
  empty: boolean
  /** False for a 16:9 project, which the feed will letterbox. */
  vertical: boolean
  /** True while the dialog is rendering, so the form does not invite a second. */
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}

export function MintspacePublish(props: MintspacePublishProps) {
  const { render, empty, vertical, busy, onBusyChange, onClose } = props

  const configured = isMintspaceConfigured()
  const [account, setAccount] = useState<MintspaceAccount | null>(null)
  const [loading, setLoading] = useState(configured)
  const [caption, setCaption] = useState('')
  // Two states rather than one: `working` covers the whole act from the click,
  // so nothing invites a second press in the moment before the encoder reports
  // for the first time, while `stage` is only what to *say* during the parts
  // the dialog's own progress bar is not describing.
  const [working, setWorking] = useState(false)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [published, setPublished] = useState<PublishedVideo | null>(null)

  // Restoring a session is a round trip, and it decides which of two completely
  // different forms is shown — so it happens as the panel opens rather than
  // when someone reaches for the publish button.
  useEffect(() => {
    if (!configured) return
    let cancelled = false

    void (async () => {
      try {
        const found = await currentAccount()
        if (!cancelled) setAccount(found)
      } catch (cause) {
        // A session that cannot be resolved is not an error to shout about: it
        // leaves the panel showing the sign-in form, which is the right next
        // step anyway.
        if (!cancelled) setError(mintspaceErrorMessage(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [configured])

  const publish = async () => {
    setError(null)
    setPublished(null)
    setWorking(true)
    onBusyChange(true)

    try {
      const video = await render()
      const result = await publishVideo({ video, caption, onStage: setStage })
      setPublished(result)
      setCaption('')
    } catch (cause) {
      // Cancelling the render is a decision, not a fault: the user pressed the
      // dialog's own cancel button and does not need telling what they did.
      if (!isAbort(cause)) setError(mintspaceErrorMessage(cause))
    } finally {
      setStage(null)
      setWorking(false)
      onBusyChange(false)
    }
  }

  const locked = busy || working

  if (!configured) {
    return (
      <Callout tone="warn" title="No Mintspace behind this site">
        This deployment has no Mintspace project configured, so there is nowhere to publish to.
        Whoever deployed it needs to set <code>VITE_MINTSPACE_SUPABASE_URL</code> and{' '}
        <code>VITE_MINTSPACE_SUPABASE_ANON_KEY</code>. Rendering and downloading works regardless.
      </Callout>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {!vertical ? (
        <Callout tone="warn" title="This is a horizontal project">
          Mintspace plays full-screen and vertical, so a 16:9 export sits in a letterbox with black
          above and below it. Switch the project to vertical above the preview to fill the screen.
        </Callout>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-dim">
          <Spinner /> Checking for a Mintspace session…
        </p>
      ) : account ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-dim">Posting as</span>
            <span className="font-medium">@{account.username}</span>
            <Button
              variant="ghost"
              className="ml-auto"
              disabled={locked}
              onClick={() => {
                void (async () => {
                  try {
                    await signOut()
                    setAccount(null)
                    setPublished(null)
                  } catch (cause) {
                    setError(mintspaceErrorMessage(cause))
                  }
                })()
              }}
            >
              Sign out
            </Button>
          </div>

          <Field
            label="Caption"
            htmlFor="mintspace-caption"
            hint={`Optional. ${caption.length}/${CAPTION_MAX_LENGTH}`}
          >
            <TextArea
              id="mintspace-caption"
              rows={2}
              maxLength={CAPTION_MAX_LENGTH}
              value={caption}
              disabled={locked}
              placeholder="Say something about it"
              onChange={(event) => setCaption(event.target.value)}
            />
          </Field>
        </>
      ) : (
        <SignInForm
          disabled={locked}
          onSignedIn={(signedIn) => {
            setAccount(signedIn)
            setError(null)
          }}
        />
      )}

      {stage ? (
        <p className="flex items-center gap-2 text-sm">
          <Spinner /> {stage}
        </p>
      ) : account && !locked ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void publish()} disabled={empty}>
            <span aria-hidden>📤</span> Render and publish to Mintspace
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}

      {error ? (
        <Callout tone="error" title="Could not publish">
          {error}
        </Callout>
      ) : null}

      {published ? (
        <Callout tone="success" title="Published">
          It is in the feed now.{' '}
          <a
            className="underline underline-offset-2"
            href={published.siteUrl || published.videoUrl}
            target="_blank"
            rel="noreferrer"
          >
            {published.siteUrl ? 'Open Mintspace' : 'Open the video'}
          </a>
          .
        </Callout>
      ) : null}
    </div>
  )
}

/**
 * Sign in, or make an account, without leaving the export.
 *
 * Both live in one form because the difference between them is one field and
 * one call, and because the person who has just rendered something to post is
 * exactly the person most likely not to have an account yet. Sending them to
 * another site to make one, and back here to find their export gone, would be
 * the sort of thing that gets an export downloaded instead.
 */
function SignInForm({
  disabled,
  onSignedIn,
}: {
  disabled: boolean
  onSignedIn: (account: MintspaceAccount) => void
}) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmationSent, setConfirmationSent] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  const submit = async () => {
    setError(null)
    setWorking(true)
    try {
      if (mode === 'sign-in') {
        onSignedIn(await signIn(email, password))
        return
      }

      const result = await signUp(email, password, username)
      // Mintspace confirms addresses by default, in which case sign-up hands
      // back no session at all and there is nothing to publish as yet.
      if (result.needsConfirmation || !result.account) {
        setConfirmationSent(true)
        return
      }
      onSignedIn(result.account)
    } catch (cause) {
      setError(mintspaceErrorMessage(cause))
    } finally {
      setWorking(false)
    }
  }

  if (confirmationSent) {
    return (
      <Callout tone="info" title="Confirm your email first">
        Mintspace has sent a link to {email}. Open it, then come back and sign in — the export is
        still here.
      </Callout>
    )
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface-2/40 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="text-sm text-ink-dim">
        {mode === 'sign-in'
          ? 'Sign in to your Mintspace account to post this.'
          : 'Make a Mintspace account to post this.'}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email" htmlFor="mintspace-email">
          <TextInput
            id="mintspace-email"
            ref={emailRef}
            type="email"
            required
            autoComplete="email"
            value={email}
            disabled={disabled || working}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="mintspace-password">
          <TextInput
            id="mintspace-password"
            type="password"
            required
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            value={password}
            disabled={disabled || working}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
      </div>

      {mode === 'sign-up' ? (
        <Field
          label="Username"
          htmlFor="mintspace-username"
          hint="Letters, numbers, dots and underscores. Mintspace tidies up anything else, and picks one from your address if you leave it empty."
        >
          <TextInput
            id="mintspace-username"
            autoComplete="username"
            value={username}
            disabled={disabled || working}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
      ) : null}

      {error ? <Callout tone="error">{error}</Callout> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={disabled || working}>
          {working ? <Spinner /> : null}
          {mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || working}
          onClick={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
            setError(null)
            emailRef.current?.focus()
          }}
        >
          {mode === 'sign-in' ? 'I need an account' : 'I already have one'}
        </Button>
      </div>
    </form>
  )
}
