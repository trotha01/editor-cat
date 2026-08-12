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
import { sha256Hex } from '../lib/digest'
import { isMintspaceConfigured, mintspaceSiteUrl } from '../lib/mintspace/client'
import {
  publicationsOf,
  publishedAs,
  publishedFrom,
  sourceKeyOf,
} from '../lib/mintspace/publications'
import {
  CAPTION_MAX_LENGTH,
  currentAccount,
  deleteVideo,
  mintspaceErrorMessage,
  publishVideo,
  signIn,
  signOut,
  signUp,
  type MintspaceAccount,
} from '../lib/mintspace/publish'
import type { Project, Publication } from '../lib/types'

export interface MintspacePublishProps {
  /** Renders the timeline to an MP4 — or hands back one already rendered. */
  render: () => Promise<Blob>
  /**
   * The project being published, for the videos it is already up as. Whole
   * rather than just the list, so the duplicate check reads it the same way
   * everything else does.
   */
  project: Project
  /** The quality setting, which with the timeline decides what comes out. */
  crf: number
  /** True when there is nothing on the timeline to publish. */
  empty: boolean
  /** False for a 16:9 project, which the feed will letterbox. */
  vertical: boolean
  /** True while the dialog is rendering, so the form does not invite a second. */
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onPublished: (publication: Publication) => void
  onForget: (videoId: string) => void
  onClose: () => void
}

export function MintspacePublish(props: MintspacePublishProps) {
  const { render, project, crf, empty, vertical, busy, onBusyChange, onClose } = props
  const { onPublished, onForget } = props

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
  // Titled as well as worded, because this one box now reports three quite
  // different failures — a session, a publish, a delete — and "Could not
  // publish" over a delete that failed is worse than no title at all.
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  /** The post just made, so the confirmation is about this press and no other. */
  const [published, setPublished] = useState<Publication | null>(null)
  /** The post a delete is being asked about, and the one being deleted. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  /**
   * What this export would be made from, or null while it is being worked out.
   *
   * Recomputed whenever the timeline or the quality changes, so the answer on
   * screen is about the export the button would produce right now.
   */
  const [sourceKey, setSourceKey] = useState<string | null>(null)

  const publications = publicationsOf(project)
  const alreadyUp = publishedFrom(project, sourceKey)

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
        if (!cancelled) {
          setError({ title: 'Could not reach Mintspace', message: mintspaceErrorMessage(cause) })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [configured])

  // Hashing the document is cheap next to rendering it, but not free, so it is
  // done here rather than during a render: the panel is only mounted while the
  // dialog is open.
  useEffect(() => {
    let cancelled = false
    void sourceKeyOf(project, { crf }).then((key) => {
      if (!cancelled) setSourceKey(key)
    })
    return () => {
      cancelled = true
    }
  }, [project, crf])

  const publish = async () => {
    setError(null)
    setPublished(null)
    setWorking(true)
    onBusyChange(true)

    try {
      const video = await render()

      // Asked of the finished file rather than of the project, and asked before
      // a byte is uploaded: this is the whole of "do not post the same video
      // twice", and the answer is only knowable once there is a file to hash.
      setStage('Checking it is not already up…')
      const digest = await sha256Hex(video)
      const already = publishedAs(project, digest)
      if (already) {
        // A refusal rather than a failure, so it is titled as one. Nothing has
        // gone wrong: the video is where the user wanted it already.
        setError({
          title: 'This is already in the feed',
          message: `The video this project exports is the one already posted${
            already.caption ? ` as “${already.caption}”` : ''
          }. Edit the project and publish that, or delete the one that is up first.`,
        })
        return
      }

      const result = await publishVideo({ video, caption, onStage: setStage })
      const publication: Publication = {
        videoId: result.id,
        storagePath: result.storagePath,
        videoUrl: result.videoUrl,
        digest: digest ?? '',
        sourceKey: sourceKey ?? undefined,
        caption: caption.trim() || null,
        publishedAt: new Date().toISOString(),
        accountId: account?.id ?? '',
        username: account?.username ?? '',
      }
      onPublished(publication)
      setPublished(publication)
      setCaption('')
    } catch (cause) {
      // Cancelling the render is a decision, not a fault: the user pressed the
      // dialog's own cancel button and does not need telling what they did.
      if (!isAbort(cause)) {
        setError({ title: 'Could not publish', message: mintspaceErrorMessage(cause) })
      }
    } finally {
      setStage(null)
      setWorking(false)
      onBusyChange(false)
    }
  }

  const remove = async (entry: Publication) => {
    setError(null)
    setConfirming(null)
    setDeleting(entry.videoId)

    try {
      await deleteVideo({
        videoId: entry.videoId,
        storagePath: entry.storagePath,
        accountId: entry.accountId,
      })
      // Forgotten whether or not there was still a row to delete. A post that
      // had already gone — taken down in Mintspace itself, or from another
      // machine — is exactly as absent from the feed as one deleted just now,
      // and keeping it listed here would only offer to delete it again.
      onForget(entry.videoId)
      if (published?.videoId === entry.videoId) setPublished(null)
    } catch (cause) {
      setError({ title: 'Could not delete it', message: mintspaceErrorMessage(cause) })
    } finally {
      setDeleting(null)
    }
  }

  const locked = busy || working || deleting !== null

  /**
   * Published videos, as rows.
   *
   * A function returning markup rather than a component of its own: it is the
   * same markup under all three headings above and depends on half this
   * component's state, so as a component it would need eight props — and as a
   * *nested* component it would remount on every keystroke in the caption.
   */
  const rowsFor = (entries: Publication[]) => (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <div key={entry.videoId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="[overflow-wrap:anywhere]">
            {entry.caption ?? <span className="text-ink-dim">No caption</span>}
          </span>
          <span className="text-xs text-ink-dim">
            @{entry.username} · {new Date(entry.publishedAt).toLocaleDateString()}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <VideoLink publication={entry} />
            {/* Only offered to a session that could actually do it. The record
                is worth showing signed out; a button that can only fail is not. */}
            {account ? (
              deleting === entry.videoId ? (
                <span className="flex items-center gap-1.5 text-xs text-ink-dim">
                  <Spinner /> Deleting…
                </span>
              ) : confirming === entry.videoId ? (
                <>
                  <Button
                    variant="danger"
                    className="px-2 py-1 text-xs"
                    onClick={() => void remove(entry)}
                  >
                    Delete for good
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-2 py-1 text-xs"
                    onClick={() => setConfirming(null)}
                  >
                    Keep it
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={locked}
                  aria-label={`Delete ${entry.caption ?? 'this video'} from Mintspace`}
                  onClick={() => setConfirming(entry.videoId)}
                >
                  🗑 Delete
                </Button>
              )
            ) : null}
          </span>
          {confirming === entry.videoId ? (
            <p className="w-full text-xs text-ink-dim">
              This takes the video out of the Mintspace feed and deletes the file. It cannot be
              undone, and anyone who has the link loses it. Your project and its media stay exactly
              as they are.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )

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

      {/* One slot, three occupants, never two at once.

          Before the form rather than after it, because whether this project is
          already up is the first thing worth knowing on opening the panel, and
          knowing it late is knowing it after a minute of rendering. What it
          says depends on how you got here: a publish you just made is news and
          reads as news; the same fact on the next visit is a record. The list
          itself is the same either way, so deleting is always to hand. */}
      {published ? (
        <Callout tone="success" title="Published">
          <p className="mb-2">
            It is in the feed now. Publishing stays off until the project changes, so the same video
            cannot go up twice.
          </p>
          {/* The post just made, from this component's own state rather than
              from the list, so the confirmation is about the press that caused
              it and cannot be empty for a parent that has yet to re-render. */}
          {rowsFor([published])}
        </Callout>
      ) : alreadyUp ? (
        <Callout tone="warn" title="Already in the Mintspace feed">
          <p className="mb-2">
            This project, at these settings, is what went up
            {alreadyUp.caption ? ` as “${alreadyUp.caption}”` : ''} on{' '}
            {new Date(alreadyUp.publishedAt).toLocaleDateString()}. Publishing again would put a
            second copy in the feed, so the button is off — edit the project, change the size or
            quality, or delete the post below.
          </p>
          {rowsFor(publications)}
        </Callout>
      ) : publications.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/40 p-3">
          <h3 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            Already in the feed
          </h3>
          {rowsFor(publications)}
        </section>
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
                    setError({
                      title: 'Could not sign out',
                      message: mintspaceErrorMessage(cause),
                    })
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
          <Button
            variant="primary"
            onClick={() => void publish()}
            disabled={empty || Boolean(alreadyUp)}
          >
            <span aria-hidden>📤</span> Render and{' '}
            {publications.length > 0 ? 'republish' : 'publish'} to Mintspace
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}

      {error ? (
        <Callout tone="error" title={error.title}>
          {error.message}
        </Callout>
      ) : null}
    </div>
  )
}

/**
 * Where to go and watch a published video.
 *
 * The feed itself when this build knows where that is, and the file otherwise —
 * Mintspace has no per-video route, so there is no third option that would land
 * on the post itself.
 */
function VideoLink({ publication }: { publication: Publication }) {
  const site = mintspaceSiteUrl()
  return (
    <a
      className="underline underline-offset-2"
      href={site || publication.videoUrl}
      target="_blank"
      rel="noreferrer"
    >
      {site ? 'Open Mintspace' : 'Open the video'}
    </a>
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
  // Untitled, unlike the panel's own: there is only one thing that can fail in
  // here, and it sits directly under the two fields that caused it.
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
