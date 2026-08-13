/**
 * The report button in the corner.
 *
 * One place to say something is broken, or ask for something, without leaving
 * the editor and without a GitHub account — which is most people who hit a bug.
 * What they write is filed as an issue on the project's tracker through
 * /api/github, using a token the deployment holds; see src/lib/feedback/issues.ts.
 *
 * Two things this component is responsible for, and neither is the form itself:
 *
 *  - Nothing is filed without a person pressing Post. There is no other path to
 *    the endpoint from the browser.
 *  - What will be published is shown *before* it is published, all of it,
 *    including the reporter's own email address. That disclosure is the whole
 *    reason the address is fetched from the server rather than assumed here: the
 *    preview shows the exact string the issue will carry, not a promise about
 *    one.
 *
 * Mounted at the root and always present, so a half-written report survives
 * being closed while you go and check what the bug actually does.
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Callout, Field, Spinner, TextArea, TextInput } from './ui'
import {
  fileIssue,
  loadIssueSupport,
  projectContext,
  shelfContext,
  supportContext,
  type FiledIssue,
  type IssueSupport,
} from '../lib/feedback/issues'
import { toDisplayMessage } from '../lib/errors'
import { orientationOf } from '../lib/orientation'
import { BUILD } from '../lib/version'
import { useDriveStore } from '../state/useDriveStore'
import { useProjectStore } from '../state/useProjectStore'
import { useWordsStore } from '../state/useWordsStore'

const KINDS = [
  { id: 'bug', label: 'Something is broken' },
  { id: 'feature', label: 'I want something' },
  { id: 'question', label: 'A question' },
] as const

type Kind = (typeof KINDS)[number]['id']

/** What the description box asks for, which is different for each kind. */
const PROMPTS: Record<Kind, string> = {
  bug: 'What did you do, what happened, and what did you expect instead?',
  feature: 'What would you like to be able to do, and what are you trying to get done?',
  question: 'What would you like to know?',
}

/**
 * Which page the bubble is sitting on, and therefore what a report from it
 * should carry besides the words somebody types.
 */
export type FeedbackScope = 'project' | 'shelf'

export function FeedbackBubble({ scope = 'project' }: { scope?: FeedbackScope }) {
  const [open, setOpen] = useState(false)
  const [support, setSupport] = useState<IssueSupport | null>(null)
  const [kind, setKind] = useState<Kind>('bug')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filed, setFiled] = useState<FiledIssue | null>(null)

  const titleRef = useRef<HTMLInputElement>(null)

  // Asked on the first open rather than on mount: most sessions never open this,
  // and a request per visit for a feature nobody used is a poor trade.
  useEffect(() => {
    if (!open || support) return
    let cancelled = false
    void loadIssueSupport().then((result) => {
      if (!cancelled) setSupport(result)
    })
    return () => {
      cancelled = true
    }
  }, [open, support])

  useEffect(() => {
    if (open) titleRef.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Report a problem or suggest a feature"
        title="Report a problem or suggest a feature"
        className="fixed right-4 bottom-4 z-30 flex size-12 items-center justify-center rounded-full bg-accent text-xl text-accent-ink shadow-lg transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden>💬</span>
      </button>
    )
  }

  const context = collectContext(scope)
  const ready = title.trim().length > 0 && body.trim().length > 0

  const post = () => {
    setPosting(true)
    setError(null)

    void fileIssue({ kind, title: title.trim(), body: body.trim(), context })
      .then((result) => {
        setFiled(result)
        setTitle('')
        setBody('')
      })
      .catch((cause: unknown) => setError(toDisplayMessage(cause)))
      .finally(() => setPosting(false))
  }

  return (
    <section
      role="dialog"
      aria-label="Report a problem"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      className="fixed right-4 bottom-4 z-30 flex max-h-[min(36rem,calc(100dvh-2rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden>💬</span> Report a problem
        </h2>
        <Button variant="ghost" onClick={() => setOpen(false)} aria-label="Close">
          ✕
        </Button>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {support === null ? (
          <Spinner />
        ) : filed ? (
          <Filed filed={filed} support={support} onAgain={() => setFiled(null)} />
        ) : !support.configured ? (
          <Callout tone="info" title="Reporting is not set up here">
            This deployment has no issue tracker configured, so there is nowhere for a report to go.
          </Callout>
        ) : (
          <>
            {error ? (
              <Callout tone="error" title="Could not post that">
                {error}
              </Callout>
            ) : null}

            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setKind(option.id)}
                  aria-pressed={kind === option.id}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    kind === option.id
                      ? 'bg-accent text-accent-ink'
                      : 'bg-surface-2 text-ink-dim hover:text-ink'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <Field label="Title" htmlFor="feedback-title">
              <TextInput
                id="feedback-title"
                ref={titleRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="One line saying what happened"
                maxLength={140}
              />
            </Field>

            <Field label="Details" htmlFor="feedback-body" hint={PROMPTS[kind]}>
              <TextArea
                id="feedback-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={6}
                placeholder={PROMPTS[kind]}
              />
            </Field>

            <details className="text-xs text-ink-dim">
              <summary className="cursor-pointer">What gets attached</summary>
              <pre className="mt-1.5 overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-relaxed">
                {[reporterLine(support), context].filter(Boolean).join('\n')}
              </pre>
            </details>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={post} disabled={posting || !ready}>
                {posting ? <Spinner /> : null}
                {support.mocked ? 'Post (mock)' : 'Post to GitHub'}
              </Button>
              <span className="text-xs text-ink-dim">
                {support.repo ? `Public issue on ${support.repo}` : 'This will be public'}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/**
 * The address the issue will carry, exactly as the server reported it.
 *
 * Shown even when there is no address, because "your account id goes on this"
 * is also something to know before pressing a button — and a blank line where
 * an address would be reads as though nothing about you is attached.
 */
function reporterLine(support: IssueSupport): string {
  return support.reporter
    ? `Reported by: ${support.reporter}`
    : 'Reported by: your account id (this site has no address for you)'
}

function Filed({
  filed,
  support,
  onAgain,
}: {
  filed: FiledIssue
  support: IssueSupport
  onAgain: () => void
}) {
  return (
    <>
      <Callout
        tone={support.mocked ? 'info' : 'success'}
        title={support.mocked ? 'Mock' : 'Thanks'}
      >
        {support.mocked ? (
          'Nothing was posted — on a deployed site this would now be an issue on the tracker.'
        ) : filed.url ? (
          <>
            Filed as{' '}
            <a
              href={filed.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline underline-offset-2"
            >
              {filed.url.replace('https://github.com/', '')}
            </a>
            . Replies go to the issue, not back into the editor.
          </>
        ) : (
          'That has been filed.'
        )}
      </Callout>
      <div>
        <Button onClick={onAgain}>Report something else</Button>
      </div>
    </>
  )
}

/**
 * This build, this browser, and the shape of whatever the reporter was working
 * on — a timeline in the editor, a shelf on the word pages.
 *
 * Read imperatively rather than subscribed to, so a bubble that is closed
 * ninety-nine times out of a hundred does not re-render on every timeline drag.
 */
function collectContext(scope: FeedbackScope): string {
  return [supportContext(BUILD), scope === 'shelf' ? shelfSummary() : projectSummary()].join('\n')
}

function projectSummary(): string {
  const { project, duration } = useProjectStore.getState()

  return projectContext({
    clips: project.clips.length,
    durationSeconds: duration(),
    audioClips: project.audioClips.length,
    captions: project.captionCues?.length ?? 0,
    orientation: orientationOf(project.width, project.height),
  })
}

function shelfSummary(): string {
  const { tiers, languages, words, selectedWord } = useWordsStore.getState()
  const { status, folder } = useDriveStore.getState()

  return shelfContext({
    tiers: tiers.length,
    languages: languages.length,
    words: words.length,
    videosOnOpenWord: selectedWord()?.videos.length ?? 0,
    driveConnected: status === 'connected' && folder !== null,
  })
}
