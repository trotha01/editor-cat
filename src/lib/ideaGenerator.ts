/**
 * The "Idea" tab's scene generator.
 *
 * Runs through the same fal `any-llm` endpoint as "Improve with AI" (see
 * `promptEnhancer.ts`), but always talks to Claude rather than whichever LLM
 * happens to be picked in Settings for prompt rewriting — the brief for this
 * feature specifically asked for Claude ideas, not "an LLM of the user's
 * choosing wrote something claude-shaped".
 */
import { run, type LlmOutput } from './falClient'
import { LLM_ENDPOINT } from './models'
import { stripWrapping } from './promptEnhancer'

export const IDEA_MODEL = 'anthropic/claude-3.5-sonnet'
export const IDEA_COUNT = 20

export const IDEA_SYSTEM_PROMPT = `You invent premises for extremely short film scenes, given a single word from the user.

Generate exactly ${IDEA_COUNT} scene ideas that all use the given word. Every idea must:
- Fit in 8-10 seconds of screen time — there is only room for one beat of action and a line or two of dialogue, so keep it tight.
- Involve one or two characters, occasionally more. Characters need not be human — they can be animals, objects, machines, ghosts, anything at all.
- Be a weird, absurd situation that would not happen in real life.
- Include a short line of dialogue, in quotes.
- Use the given word at least once, in the description or the dialogue.
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

  const output = await run<LlmOutput>(
    LLM_ENDPOINT,
    {
      model: IDEA_MODEL,
      system_prompt: IDEA_SYSTEM_PROMPT,
      prompt: trimmed,
    },
    { signal },
  )

  const ideas = parseIdeas(output.output ?? '')
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

  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      const strings = parsed
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
      if (strings.length > 0) return strings
    }
  } catch {
    // Not JSON — fall through to line-based parsing below.
  }

  return cleaned
    .split('\n')
    .map((line) => line.replace(/^[\s>*-]*\d*[.)]?\s*/, '').trim())
    .filter((line) => line.length > 0)
}
