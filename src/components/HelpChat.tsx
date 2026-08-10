/**
 * The help bubble in the corner.
 *
 * One place to ask "how do I…" without leaving the editor, and — because the
 * answer is often "you can't, that's a bug" — the place a report gets written.
 * It runs on the same fal any-llm endpoint the "Improve with AI" buttons use,
 * so it needs no key of its own; see src/lib/support/chat.ts.
 *
 * The rule this component exists to enforce is that **nothing is filed without
 * a person pressing a button on it**. The assistant drafts a report; the draft
 * arrives here as an editable card, with the build and browser details that
 * will be attached shown in full; posting is a separate, deliberate act. A model
 * that reads whatever anyone pastes into it must not be one sentence away from
 * writing to a public tracker, and this is where that is guaranteed rather than
 * asked for politely in a prompt.
 *
 * Mounted at the root and always present, so the conversation survives being
 * closed and reopened — a chat you have to start again because you looked at
 * the timeline is not one anybody uses twice.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Callout, Spinner, TextArea, TextInput } from './ui'
import {
  askAssistant,
  type ChatMessage,
  type IssueDraft,
  type IssueKind,
} from '../lib/support/chat'
import {
  fileIssue,
  loadIssueSupport,
  projectContext,
  supportContext,
  type FiledIssue,
  type IssueSupport,
} from '../lib/support/issues'
import { toDisplayMessage } from '../lib/errors'
import { orientationOf } from '../lib/orientation'
import { BUILD } from '../lib/version'
import { useProjectStore } from '../state/useProjectStore'
import { useSettingsStore } from '../state/useSettingsStore'

interface Entry extends ChatMessage {
  id: string
  /** A report the assistant drafted, awaiting the user's say-so. */
  draft?: IssueDraft
  /** What was collected about this browser and project when the draft was made. */
  context?: string
  /** Where a filed report landed, rendered as a link under the message. */
  url?: string
  /** Set once it fails, so it renders as a problem rather than as an answer. */
  failed?: boolean
}

const STARTERS = [
  'How does the timeline work?',
  'I want to report a bug',
  'I have an idea for a feature',
]

let nextId = 0
const newId = () => `entry-${(nextId += 1)}`

export function HelpChat() {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [pending, setPending] = useState(false)
  const [support, setSupport] = useState<IssueSupport | null>(null)
  const [input, setInput] = useState('')

  const llmModel = useSettingsStore((state) => state.llmModel)

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

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
    if (open) inputRef.current?.focus()
  }, [open])

  // Follows the conversation down as it grows, including while a reply is being
  // waited for — the spinner is the last thing in the list. The panel's own
  // scroller is moved rather than `scrollIntoView`, which would also drag the
  // page behind it towards a box that is fixed to the corner anyway.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries, pending])

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(
    (text: string) => {
      const question = text.trim()
      if (!question || pending) return

      const asked: Entry = { id: newId(), role: 'user', text: question }

      // A failure notice stays on screen — it is what happened — but is left
      // out of what the model is asked to continue, where it would read as
      // something the assistant said.
      const history = [...entries.filter((entry) => !entry.failed), asked].map(
        ({ role, text: body }) => ({ role, text: body }),
      )

      setEntries((current) => [...current, asked])
      setInput('')
      setPending(true)

      const controller = new AbortController()
      abortRef.current = controller

      const canFile = support?.configured === true

      void askAssistant({
        messages: history,
        model: llmModel,
        canFile,
        repo: support?.repo ?? null,
        signal: controller.signal,
      })
        .then((reply) => {
          setEntries((current) => [
            ...current,
            {
              id: newId(),
              role: 'assistant',
              text: reply.text,
              ...(reply.draft ? { draft: reply.draft, context: collectContext() } : {}),
            },
          ])
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setEntries((current) => [
            ...current,
            { id: newId(), role: 'assistant', text: toDisplayMessage(error), failed: true },
          ])
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false)
        })
    },
    [entries, llmModel, pending, support],
  )

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open help and feedback"
        title="Ask about the editor, or report a bug"
        className="fixed right-4 bottom-4 z-30 flex size-12 items-center justify-center rounded-full bg-accent text-xl text-accent-ink shadow-lg transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden>💬</span>
      </button>
    )
  }

  return (
    <section
      role="dialog"
      aria-label="Help and feedback"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
      className="fixed right-4 bottom-4 z-30 flex max-h-[min(34rem,calc(100dvh-2rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden>💬</span> Ask about editor-cat
        </h2>
        <Button variant="ghost" onClick={() => setOpen(false)} aria-label="Close help">
          ✕
        </Button>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-3" aria-live="polite">
          <Intro support={support} />

          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-2">
              <Bubble entry={entry} />
              {entry.draft ? (
                <DraftCard
                  draft={entry.draft}
                  context={entry.context ?? ''}
                  support={support}
                  onSent={(sent) => setEntries((current) => withFiled(current, entry.id, sent))}
                />
              ) : null}
            </div>
          ))}

          {pending ? (
            <span className="flex items-center gap-2 text-sm text-ink-dim">
              <Spinner /> Thinking…
            </span>
          ) : null}

          {entries.length === 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => send(starter)}
                  className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim transition hover:text-ink"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <form
        className="flex shrink-0 items-end gap-2 border-t border-line p-3"
        onSubmit={(event) => {
          event.preventDefault()
          send(input)
        }}
      >
        <TextArea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and shift+enter breaks the line, which is what every
            // other chat box does; a report is usually more than one line.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send(input)
            }
          }}
          rows={2}
          aria-label="Message"
          placeholder="Ask a question, or describe what went wrong"
          className="min-h-11 flex-1"
        />
        <Button type="submit" variant="primary" disabled={pending || !input.trim()}>
          Send
        </Button>
      </form>
    </section>
  )
}

/** Takes a filed draft off the conversation and adds a line saying where it went. */
function withFiled(entries: Entry[], id: string, sent: FiledIssue & { mocked: boolean }): Entry[] {
  const filed = entries.map((entry) => {
    if (entry.id !== id) return entry
    // The card is gone once it is posted: an editable draft of something that
    // already exists invites someone to fix a typo that will go nowhere.
    const { draft: _draft, context: _context, ...rest } = entry
    return rest
  })

  const said = sent.mocked
    ? 'Mock mode — nothing was posted. On a deployed site this would now be an issue on the tracker.'
    : 'Thanks — that has been filed.'

  return [
    ...filed,
    {
      id: newId(),
      role: 'assistant' as const,
      text: said,
      // Only ever GitHub's own `html_url`, come back through our function. The
      // scheme is still checked, because "it cannot be anything else" is how a
      // javascript: URL ends up in an anchor one refactor later.
      ...(sent.url?.startsWith('https://') ? { url: sent.url } : {}),
    },
  ]
}

function Intro({ support }: { support: IssueSupport | null }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">
      <p>
        Ask me anything about this editor — the steps, the timeline, captions, what things cost.
      </p>
      <p className="mt-1.5 text-ink-dim">
        {support === null
          ? 'You can also tell me what went wrong.'
          : support.configured
            ? `If something is broken or missing, tell me and I will draft a report${
                support.repo ? ` for ${support.repo}` : ''
              }. You see it and post it — I cannot post anything myself.`
            : 'Reporting from inside the app is not set up on this deployment, so I can only answer questions.'}
      </p>
    </div>
  )
}

function Bubble({ entry }: { entry: Entry }) {
  if (entry.failed) {
    return (
      <Callout tone="error" title="That did not work">
        {entry.text}
      </Callout>
    )
  }

  const mine = entry.role === 'user'

  return (
    <p
      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] ${
        mine ? 'self-end bg-accent text-accent-ink' : 'self-start bg-surface-2 text-ink'
      }`}
    >
      {entry.text}
      {entry.url ? (
        <>
          {' '}
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {entry.url.replace('https://github.com/', '')}
          </a>
        </>
      ) : null}
    </p>
  )
}

const KIND_LABELS: Record<IssueKind, string> = {
  bug: 'Bug',
  feature: 'Feature request',
  question: 'Question',
}

/**
 * The draft, before it is anything at all.
 *
 * Editable in full, because the assistant wrote it from a conversation and the
 * person it happened to is the one who knows what is wrong with the summary.
 * The collected details are behind a disclosure rather than hidden: attaching a
 * user agent to someone's public report without showing it to them first is not
 * a thing to do quietly.
 */
function DraftCard({
  draft,
  context,
  support,
  onSent,
}: {
  draft: IssueDraft
  context: string
  support: IssueSupport | null
  onSent: (sent: FiledIssue & { mocked: boolean }) => void
}) {
  const [kind, setKind] = useState<IssueKind>(draft.kind)
  const [title, setTitle] = useState(draft.title)
  const [body, setBody] = useState(draft.body)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  const post = () => {
    setPosting(true)
    setError(null)

    void fileIssue({ kind, title: title.trim(), body: body.trim(), context })
      .then((filed) => onSent({ ...filed, mocked: support?.mocked === true }))
      .catch((cause: unknown) => {
        setError(toDisplayMessage(cause))
        setPosting(false)
      })
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
        Draft report — nothing is posted until you press the button
      </p>

      {error ? (
        <Callout tone="error" title="Could not post that">
          {error}
        </Callout>
      ) : null}

      <div className="flex gap-2">
        {(Object.keys(KIND_LABELS) as IssueKind[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            aria-pressed={kind === option}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              kind === option ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-dim'
            }`}
          >
            {KIND_LABELS[option]}
          </button>
        ))}
      </div>

      <TextInput
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        aria-label="Report title"
        placeholder="One line saying what happened"
      />
      <TextArea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label="Report details"
        rows={5}
      />

      {context ? (
        <details className="text-xs text-ink-dim">
          <summary className="cursor-pointer">What gets attached</summary>
          <pre className="mt-1.5 overflow-x-auto rounded-lg bg-surface-2 p-2 text-[11px] leading-relaxed">
            {context}
          </pre>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={post}
          disabled={posting || !title.trim() || !body.trim()}
        >
          {posting ? <Spinner /> : null}
          {support?.mocked ? 'Post (mock)' : 'Post to GitHub'}
        </Button>
        <Button variant="ghost" onClick={() => setDismissed(true)} disabled={posting}>
          Discard
        </Button>
        <span className="text-xs text-ink-dim">
          {support?.repo ? `Public issue on ${support.repo}` : 'This will be public'}
        </span>
      </div>
    </div>
  )
}

/**
 * What is attached to a report: this build, this browser, and the shape of the
 * project open at the time.
 *
 * Read imperatively rather than subscribed to, so a bubble that is closed
 * ninety-nine times out of a hundred does not re-render on every timeline drag.
 */
function collectContext(): string {
  const { project, duration } = useProjectStore.getState()

  return [
    supportContext(BUILD),
    projectContext({
      clips: project.clips.length,
      durationSeconds: duration(),
      audioClips: project.audioClips.length,
      captions: project.captionCues?.length ?? 0,
      orientation: orientationOf(project.width, project.height),
    }),
  ].join('\n')
}
