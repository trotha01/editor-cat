/**
 * The "Idea" tab's scene generator.
 *
 * Calls the Claude API directly, rather than routing through fal's `any-llm`
 * endpoint the way "Improve with AI" does (see `promptEnhancer.ts`) — the brief
 * for this feature specifically asked for Claude ideas, not "an LLM of the
 * user's choosing wrote something claude-shaped", and going straight to
 * Anthropic means the model actually used is never at the mercy of fal's own
 * model catalogue.
 */
import { createMessage } from './claudeClient'
import { isMockEnabled, mockIdeas } from './mock'
import { stripWrapping } from './promptEnhancer'

export const IDEA_MODEL = 'claude-opus-5'
export const IDEA_COUNT = 20
export const IDEA_MAX_TOKENS = 4096

export const IDEA_SYSTEM_PROMPT = `You invent premises for extremely short film scenes, given a single word from the user.

Generate exactly ${IDEA_COUNT} scene ideas that all use the given word. Every idea must:
- Fit in 8-10 seconds of screen time — there is only room for one beat of action and a line or two of dialogue, so keep it tight.
- Involve one or two characters, occasionally more. Characters need not be human — they can be animals, objects, machines, ghosts, anything at all.
- Be a weird, absurd situation that would not happen in real life.
- Include a short line of dialogue, in quotes, and the dialogue itself must use the given word at least once — not just the surrounding description.
- Keep the word incidental: it must not be the scene's main action, goal, or topic — just a word one of the characters happens to say in passing. The scene should be about something else entirely.
- Be as succinct as possible — a sentence or two, never a paragraph.

Output a JSON array of exactly ${IDEA_COUNT} strings and nothing else. No markdown, no numbering, no commentary.`

export interface GenerateIdeasOptions {
  word: string
  signal?: AbortSignal
}

/** Asks Claude for a batch of scene ideas built around a single word. */
export async function generateIdeas({ word, signal }: GenerateIdeasOptions): Promise<string[]> {
  const trimmed = word.trim()
  if (!trimmed) throw new Error('Type a word first, then generate ideas.')

  if (isMockEnabled()) return mockIdeas(trimmed)

  const text = await createMessage({
    model: IDEA_MODEL,
    system: IDEA_SYSTEM_PROMPT,
    prompt: trimmed,
    maxTokens: IDEA_MAX_TOKENS,
    signal,
  })

  const ideas = parseIdeas(text)
  if (ideas.length === 0) {
    throw new Error('Claude returned no ideas. Try a different word.')
  }
  return ideas
}

/**
 * Pulls a list of ideas out of the model's raw text.
 *
 * Asked for a JSON array, but models routinely answer with a numbered list or
 * bullet points instead — the same conversational drift `stripWrapping`
 * exists to undo for a single prompt. JSON is tried first because it survives
 * an idea that itself contains a line break or a leading digit; the line-based
 * fallback covers everything else.
 */
export function parseIdeas(text: string): string[] {
  const cleaned = stripWrapping(text)

  const strings =
    parseJsonStringArray(cleaned) ?? parseJsonStringArray(closeTrailingString(cleaned))
  if (strings) return strings

  // The response is JSON-shaped but broken somewhere in the middle rather than
  // just at the end — the closing-quote repair above only fixes the last
  // element. Pulling out every well-formed `"..."` literal still recovers
  // most of the list instead of the whole array collapsing into one line.
  // Gated on actually looking like a JSON array so this doesn't hijack a
  // numbered or bulleted list whose lines happen to quote some dialogue.
  if (cleaned.trim().startsWith('[')) {
    const literals = extractQuotedLiterals(cleaned)
    if (literals.length > 1) return literals
  }

  return cleaned
    .split('\n')
    .map((line) => line.replace(/^[\s>*-]*\d*[.)]?\s*/, '').trim())
    .filter((line) => line.length > 0)
}

/** Parses `text` as a JSON array of non-blank strings, or null if it isn't one. */
function parseJsonStringArray(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return null
    const strings = parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    return strings.length > 0 ? strings : null
  } catch {
    return null
  }
}

/**
 * Claude occasionally drops the quote that closes the array's last string —
 * easy to do when the line right before it already ends on a quoted piece of
 * dialogue. Putting it back recovers an otherwise well-formed 20-idea
 * response from a single missing character, rather than losing all of it.
 */
function closeTrailingString(text: string): string {
  const trimmed = text.trim()
  return trimmed.endsWith(']') ? `${trimmed.slice(0, -1)}"]` : text
}

/** Every complete `"..."` JSON string literal in `text`, in order. */
function extractQuotedLiterals(text: string): string[] {
  const literals: string[] = []
  for (const match of text.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
    try {
      const value: unknown = JSON.parse(match)
      if (typeof value === 'string' && value.trim().length > 0) literals.push(value.trim())
    } catch {
      // A literal that doesn't parse on its own is skipped rather than kept broken.
    }
  }
  return literals
}
