/**
 * The two "Improve with AI" buttons.
 *
 * These deliberately use *different* instructions. Rewriting a prompt for a
 * still image and rewriting one for image-to-video are close to opposite jobs:
 *
 *  - An image prompt should describe what is in the frame — subject,
 *    composition, light, lens, style.
 *  - A video prompt is given the first frame as an actual image, so restating
 *    the contents wastes the model's attention. What it needs is what
 *    *changes*: subject motion, camera movement, and pacing.
 *
 * Sending the same generic "make this better" text to both is the usual way
 * this feature ends up useless, so the split is the point.
 */
import { run, type LlmOutput } from './falClient'
import { LLM_ENDPOINT } from './models'

const IMAGE_SYSTEM = `You rewrite prompts for text-to-image models.

Rewrite the user's prompt into a single richly detailed paragraph that a diffusion model can render well. Cover, where it makes sense:
- the main subject and what it is doing
- composition and framing
- lighting: direction, quality, colour temperature
- lens and perspective (e.g. 35mm, wide angle, macro)
- material and surface detail
- overall style and colour grading

Rules:
- Keep the user's actual intent, subject and any named specifics exactly. Do not substitute a different subject.
- If the user asked for a particular style, keep it and deepen it rather than replacing it.
- Output ONLY the rewritten prompt. No preamble, no quotes, no explanation, no markdown.
- One paragraph. Aim for 60-120 words.`

const VIDEO_SYSTEM = `You rewrite prompts for image-to-video models.

The user already has the opening frame as an image; the model receives that image directly. So do NOT re-describe static content that is already visible in it. Describe what CHANGES over the shot:
- subject motion: what moves, in what direction, how fast
- camera movement: push in, pull out, pan, tilt, orbit, handheld drift, or locked off
- pacing and duration feel: whether this is one slow continuous move or a quicker gesture
- atmospheric motion: drifting smoke, falling snow, rippling water, flickering light
- how the shot ends

Rules:
- Describe one continuous shot. No cuts, no scene changes, no shot lists.
- Keep the user's intent. If they asked for a specific camera move, keep it.
- Motion must be plausible for a few seconds of footage — avoid asking for long journeys or multiple actions in sequence.
- Output ONLY the rewritten prompt. No preamble, no quotes, no explanation, no markdown.
- One paragraph. Aim for 40-90 words.`

export type EnhanceKind = 'image' | 'video'

export interface EnhanceOptions {
  key: string
  kind: EnhanceKind
  prompt: string
  model: string
  signal?: AbortSignal
}

/** Rewrites a prompt, returning the improved text. */
export async function enhancePrompt({
  key,
  kind,
  prompt,
  model,
  signal,
}: EnhanceOptions): Promise<string> {
  const trimmed = prompt.trim()
  if (!trimmed) throw new Error('Write a prompt first, then improve it.')

  const output = await run<LlmOutput>(
    LLM_ENDPOINT,
    {
      model,
      system_prompt: kind === 'image' ? IMAGE_SYSTEM : VIDEO_SYSTEM,
      prompt: trimmed,
    },
    { key, signal },
  )

  const improved = (output.output ?? '').trim()
  if (!improved) {
    throw new Error('The model returned an empty prompt. Try again, or pick a different LLM.')
  }
  return stripWrapping(improved)
}

/**
 * Models often ignore "no preamble" and answer conversationally anyway. This
 * pulls the actual prompt back out so the user is not handed
 * `Here's an improved prompt: "..."` to paste into an image model.
 */
export function stripWrapping(text: string): string {
  let out = text.trim()

  out = out.replace(/^(here(?:'s| is)[^:\n]*:|improved prompt:|rewritten prompt:|prompt:)\s*/i, '')
  out = out.replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```$/i, '')

  // Unwrap only if the quotes surround the whole thing.
  const quoted = /^"([\s\S]+)"$/.exec(out.trim()) ?? /^'([\s\S]+)'$/.exec(out.trim())
  if (quoted?.[1] && !quoted[1].includes('"')) out = quoted[1]

  return out.trim()
}
