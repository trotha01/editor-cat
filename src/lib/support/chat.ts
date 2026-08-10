/**
 * The conversation behind the chat bubble.
 *
 * It runs on the same fal any-llm endpoint the two "Improve with AI" buttons
 * use, through the same /api/fal proxy, which is what makes it free of any new
 * key or provider: the deployment already pays for that endpoint and the proxy
 * already checks who is asking.
 *
 * That endpoint takes a system prompt and a single prompt string — it has no
 * notion of a conversation and no tool calling. Both shape this file:
 *
 *  - The history is written out as a transcript and sent as the prompt. See
 *    {@link buildPrompt}, and the budget it keeps to.
 *  - A report is handed back as a fenced block in the reply text rather than as
 *    a tool call, and parsed back out here. See {@link parseReply}.
 *
 * The block is only ever a *draft*. It is shown to the user, who edits it if
 * they want to and presses a button; nothing here can reach GitHub. That is the
 * design, not an omission — a model that could file on its own would be one
 * misread sentence away from posting to a public tracker, and this one reads
 * text that people paste in.
 */
import { run, type LlmOutput } from '../falClient'
import { LLM_ENDPOINT } from '../models'
import { supportSystemPrompt } from './knowledge'

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  text: string
}

export const ISSUE_KINDS = ['bug', 'feature', 'question'] as const

export type IssueKind = (typeof ISSUE_KINDS)[number]

/** A report the assistant has drafted, before anyone has agreed to file it. */
export interface IssueDraft {
  kind: IssueKind
  title: string
  body: string
}

export interface AssistantReply {
  /** What to show in the chat, with any report block taken out of it. */
  text: string
  /** The report the model drafted, if it drafted one. */
  draft: IssueDraft | null
}

/**
 * How much transcript to send.
 *
 * A cap rather than a message count, because one pasted stack trace is worth
 * twenty ordinary turns. Older turns are dropped first: the last thing said is
 * what the next reply has to answer, and a conversation this long has usually
 * moved on from how it started anyway.
 */
const PROMPT_BUDGET = 8000

/** Long enough for a stack trace, short enough that one message cannot fill the budget. */
const MESSAGE_LIMIT = 2000

const LABEL: Record<ChatRole, string> = { user: 'User', assistant: 'Assistant' }

export function buildPrompt(messages: ChatMessage[]): string {
  const turns: string[] = []
  let spent = 0

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    const text = message.text.slice(0, MESSAGE_LIMIT)
    const turn = `${LABEL[message.role]}: ${text}`

    // Always keep the newest turn, however long it is — a budget that can drop
    // the question leaves the model answering nothing at all.
    if (spent + turn.length > PROMPT_BUDGET && turns.length > 0) break

    turns.unshift(turn)
    spent += turn.length
  }

  // The trailing label is what stops smaller models from writing both sides of
  // the conversation, which they will otherwise cheerfully do.
  return `${turns.join('\n\n')}\n\nAssistant:`
}

export interface AskOptions {
  messages: ChatMessage[]
  /** Which LLM to run on, from the same picker the "Improve with AI" buttons use. */
  model: string
  /** Whether this deployment can file issues, which changes what the model is told. */
  canFile: boolean
  repo: string | null
  signal?: AbortSignal
}

export async function askAssistant({
  messages,
  model,
  canFile,
  repo,
  signal,
}: AskOptions): Promise<AssistantReply> {
  const output = await run<LlmOutput>(
    LLM_ENDPOINT,
    {
      model,
      system_prompt: supportSystemPrompt({ canFile, repo }),
      prompt: buildPrompt(messages),
    },
    { signal },
  )

  const raw = (output.output ?? '').trim()
  if (!raw) {
    throw new Error(
      'The assistant returned nothing. Try again, or pick a different model in Settings.',
    )
  }

  return parseReply(raw, { canFile })
}

/** ```report … ``` — the fence the model is asked to hand a draft back in. */
const REPORT_FENCE = /```\s*report\s*\r?\n([\s\S]*?)(?:```|$)/i

/**
 * Splits a reply into what to show and what was drafted.
 *
 * Written to be forgiving, because the models this can run on range from
 * Claude down to a 3B Llama, and the small ones treat "reply with exactly this
 * block" as a suggestion. So: the fence may be unterminated, the JSON may
 * arrive with a trailing comma or as plain `key: value` lines, and the label
 * may be missing.
 *
 * What it will not do is invent a report. Anything it cannot read as one is
 * left in the visible text, where the user can see the model made a mess of it
 * — better than silently offering to file something nobody wrote.
 */
export function parseReply(raw: string, { canFile }: { canFile: boolean }): AssistantReply {
  const match = REPORT_FENCE.exec(raw)

  // With nowhere to file, a block is a model ignoring its instructions. Leaving
  // the JSON on screen would be the worst of both, so it is dropped.
  if (!match) return { text: tidy(raw), draft: null }
  if (!canFile) return { text: tidy(raw.replace(match[0], '')), draft: null }

  const draft = readDraft(match[1] ?? '')
  const text = tidy(raw.replace(match[0], ''))

  // A reply that was *only* a block still needs something above the draft card.
  if (draft && !text) return { text: 'Here is the report I have drafted.', draft }

  return { text: text || tidy(raw), draft }
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

function readDraft(inner: string): IssueDraft | null {
  const parsed = readJson(inner) ?? readLines(inner)
  if (!parsed) return null

  const title = parsed.title?.trim()
  const body = parsed.body?.trim()
  if (!title || !body) return null

  return { kind: readKind(parsed.kind), title, body }
}

interface LooseDraft {
  kind?: string
  title?: string
  body?: string
}

function readJson(inner: string): LooseDraft | null {
  const start = inner.indexOf('{')
  const end = inner.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  const candidate = inner.slice(start, end + 1)

  for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as LooseDraft
      }
    } catch {
      // Try the next repair, then fall through to the line reader.
    }
  }

  return null
}

/**
 * The fallback for a model that wrote the fields out as lines instead of JSON.
 * `body` takes everything after its own label, since that is the field people
 * write paragraphs into.
 */
function readLines(inner: string): LooseDraft | null {
  const kind = /^\s*kind\s*:\s*(.+)$/im.exec(inner)?.[1]
  const title = /^\s*title\s*:\s*(.+)$/im.exec(inner)?.[1]
  const bodyAt = /^\s*body\s*:\s*/im.exec(inner)

  if (!title || !bodyAt) return null

  const body = inner.slice((bodyAt.index ?? 0) + bodyAt[0].length)
  return { kind: kind?.trim(), title: title.trim(), body: body.trim() }
}

/**
 * Maps whatever word the model reached for onto a kind the tracker knows.
 * Defaults to a bug: it is the commonest report, and the kind only picks a
 * label on an issue a person is about to read anyway.
 */
function readKind(value: string | undefined): IssueKind {
  const word = (value ?? '').trim().toLowerCase()

  if (ISSUE_KINDS.includes(word as IssueKind)) return word as IssueKind
  if (/enhance|request|idea|wish|feature/.test(word)) return 'feature'
  if (/question|ask|help|support/.test(word)) return 'question'
  return 'bug'
}
