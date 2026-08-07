/**
 * The Idea step: one word becomes one sentence.
 *
 * Everything downstream of it is a prompt, and a prompt is easier to write when
 * you already know what the shot is *about*. So this step deliberately refuses
 * to be a prompt box: you give it a single word in a single language, and the
 * only thing you are asked to produce is one sentence.
 *
 * The AI here is used three times, and never to write the idea for you:
 *
 *  - verbs that could act on your word,
 *  - objects your word could act on,
 *  - and, once a sentence exists, other sentences built around one word you
 *    picked out of it.
 *
 * All three answer with a *list*, which is the opposite of what the prompt
 * enhancer wants — hence a parser of its own rather than `stripWrapping`.
 * Models are not reliable about list formatting, so `parseSuggestions` assumes
 * nothing beyond "one per line, probably".
 */
import { run, type LlmOutput } from './falClient'
import { LLM_ENDPOINT } from './models'

export interface Language {
  code: string
  label: string
}

/**
 * Latin is first because it is the default, and it is the default because this
 * step is at its most useful for a language you are still assembling sentences
 * in a word at a time. Codes are our own and are stored; labels are what the
 * model is told, so renaming a label changes prompts but breaks no saved state.
 */
export const LANGUAGES: readonly Language[] = [
  { code: 'latin', label: 'Latin' },
  { code: 'english', label: 'English' },
  { code: 'spanish', label: 'Spanish' },
  { code: 'french', label: 'French' },
  { code: 'german', label: 'German' },
  { code: 'italian', label: 'Italian' },
  { code: 'portuguese', label: 'Portuguese' },
  { code: 'ancient-greek', label: 'Ancient Greek' },
  { code: 'japanese', label: 'Japanese' },
  { code: 'mandarin', label: 'Mandarin Chinese' },
  { code: 'russian', label: 'Russian' },
  { code: 'arabic', label: 'Arabic' },
]

export const DEFAULT_LANGUAGE = LANGUAGES[0]!.code

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code
}

/** What a suggestion is offered as: something the word does, or something it acts on. */
export type PartRole = 'verb' | 'object'

export interface Suggestion {
  text: string
  /** A short English gloss, when the model gave one. Optional on purpose. */
  gloss?: string
}

const HOW_MANY_PARTS = 6
const HOW_MANY_IDEAS = 4

/*
 * The two system prompts below are also what mock mode matches on, so that an
 * offline build answers with a list rather than the enhancer's paragraph. The
 * phrases it looks for are "one per line" and "one-sentence ideas" — see
 * `mockLlm` in src/lib/mock.ts before rewording either line.
 */

function partsSystem(role: PartRole, language: string): string {
  const wanted =
    role === 'verb'
      ? `verbs the word could plausibly do, or have done to it`
      : `concrete nouns the word could act on, be near, or belong to`

  return `You suggest words for someone building a single sentence in ${language}.

Return ONLY ${HOW_MANY_PARTS} ${wanted}, one per line, each followed by an em dash and a two or three word English gloss:

term — what it means

Rules:
- Every term must be ${language}, and must be ready to drop into the sentence as it stands: inflect it for the word it goes with rather than giving a dictionary form.
- Prefer things that can be pictured — this sentence becomes an image later, so "gleams" beats "exists" and "harbour" beats "concept".
- Vary them. Six near-synonyms is one suggestion, not six.
- No numbering, no bullets, no preamble, no explanation, no markdown.`
}

function ideasSystem(language: string): string {
  return `You suggest ideas for someone writing a single sentence in ${language}.

You are given their sentence and one word inside it. Return ONLY ${HOW_MANY_IDEAS} one-sentence ideas built around that word, one per line, each followed by an em dash and a short English translation:

sentence — translation

Rules:
- Each idea is exactly one sentence in ${language}, and short enough to say in a breath.
- Keep the chosen word, or an inflected form of it, at the centre of every one.
- Change what surrounds it. Four rephrasings of the sentence you were given is a failure; four different situations is the job.
- Every idea must be picturable: a thing happening somewhere, not a statement about the world.
- No numbering, no bullets, no quotes, no preamble, no markdown.`
}

export interface PartsOptions {
  role: PartRole
  word: string
  language: string
  /** What has been written so far, so suggestions fit rather than restart. */
  sentence?: string
  model: string
  signal?: AbortSignal
}

/** Asks for verbs or objects that could join the word in a sentence. */
export async function suggestParts({
  role,
  word,
  language,
  sentence = '',
  model,
  signal,
}: PartsOptions): Promise<Suggestion[]> {
  const trimmed = word.trim()
  if (!trimmed) throw new Error('Write a word first, then ask for suggestions.')

  const label = languageLabel(language)
  const output = await run<LlmOutput>(
    LLM_ENDPOINT,
    {
      model,
      system_prompt: partsSystem(role, label),
      prompt: [
        `Word: ${trimmed}`,
        `Language: ${label}`,
        `Sentence so far: ${sentence.trim() || '(nothing yet)'}`,
      ].join('\n'),
    },
    { signal },
  )

  return requireSuggestions(parseSuggestions(output.output ?? '', { limit: HOW_MANY_PARTS }))
}

export interface IdeasOptions {
  /** The word the whole idea started from, for context. */
  word: string
  language: string
  sentence: string
  /** The verb or noun picked out of the sentence to build on. */
  focus: string
  model: string
  signal?: AbortSignal
}

/** Asks for other one-sentence ideas built around one word of the sentence. */
export async function suggestIdeas({
  word,
  language,
  sentence,
  focus,
  model,
  signal,
}: IdeasOptions): Promise<Suggestion[]> {
  const trimmedSentence = sentence.trim()
  if (!trimmedSentence) throw new Error('Write an idea first, then explore a word in it.')
  if (!focus.trim()) throw new Error('Pick a word in your idea first.')

  const label = languageLabel(language)
  const output = await run<LlmOutput>(
    LLM_ENDPOINT,
    {
      model,
      system_prompt: ideasSystem(label),
      prompt: [
        `Language: ${label}`,
        `Sentence: ${trimmedSentence}`,
        `Build on: ${focus.trim()}`,
        `The word this started from: ${word.trim() || '(none given)'}`,
      ].join('\n'),
    },
    { signal },
  )

  return requireSuggestions(
    parseSuggestions(output.output ?? '', { limit: HOW_MANY_IDEAS, sentences: true }),
  )
}

function requireSuggestions(suggestions: Suggestion[]): Suggestion[] {
  if (suggestions.length === 0) {
    throw new Error('The model returned nothing usable. Try again, or pick a different LLM.')
  }
  return suggestions
}

/* --- Parsing what came back ---------------------------------------------- */

export interface ParseOptions {
  limit?: number
  /**
   * Whether the entries are whole sentences. Sentences keep their closing
   * punctuation and are never split on commas; single words lose a trailing
   * full stop, because "currit." is not a word anyone wants in a chip.
   */
  sentences?: boolean
}

/** Leading bullet or numbering, in every shape models produce them. */
const LEADING_MARKER = /^\s*(?:[-–—•*·]|\d+[.)]|\(\d+\))\s*/
const FENCE = /^\s*```/
const HEADING = /:\s*$/

/**
 * Turns a model's answer into suggestions.
 *
 * Written to be forgiving rather than strict: the instruction "no bullets, no
 * numbering" is ignored often enough that treating a numbered list as a failed
 * response would make the feature feel broken several times an hour.
 */
export function parseSuggestions(
  raw: string,
  { limit = 8, sentences }: ParseOptions = {},
): Suggestion[] {
  let lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !FENCE.test(line) && !HEADING.test(line))

  // Some models answer on one line regardless. Commas are a safe separator for
  // words and a terrible one for sentences, so this only applies to words.
  if (!sentences && lines.length === 1 && lines[0]!.includes(',')) {
    lines = lines[0]!.split(',')
  }

  const seen = new Set<string>()
  const suggestions: Suggestion[] = []

  for (const line of lines) {
    const suggestion = splitGloss(line.replace(LEADING_MARKER, ''), sentences === true)
    if (!suggestion) continue

    const key = suggestion.text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    suggestions.push(suggestion)
    if (suggestions.length === limit) break
  }

  return suggestions
}

/**
 * Separates a term from its gloss. The em dash is what was asked for; the rest
 * are what arrives anyway. A bare hyphen only counts when it is spaced, so
 * hyphenated words survive.
 */
function splitGloss(line: string, sentence: boolean): Suggestion | null {
  const patterns = [
    /^([^—–]+?)\s*[—–]\s*(\S.*)$/,
    /^(.+?)\s+-\s+(\S.*)$/,
    /^([^:]+?)\s*:\s+(\S.*)$/,
    /^(.+?)\s*\((.+)\)\s*$/,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(line)
    if (!match) continue
    const text = clean(match[1]!, sentence)
    // Cleaned the same way as the entry: the gloss on a word is a word or two,
    // but the gloss on an idea is a translation, and translations keep their
    // full stop.
    const gloss = clean(match[2]!, sentence)
    if (text) return gloss ? { text, gloss } : { text }
  }

  const text = clean(line, sentence)
  return text ? { text } : null
}

/** Quote marks a model wraps entries in, as matched pairs. */
const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
] as const

/**
 * Unwraps an entry that is quoted end to end. Only balanced pairs count, so a
 * gloss that merely *ends* in a quote — `what a sign says, e.g. "OPEN"` — keeps
 * it.
 */
function unquote(value: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (value.length > open.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, -close.length).trim()
    }
  }
  return value
}

function clean(value: string, sentence: boolean): string {
  // A comma or semicolon is always list punctuation rather than part of the
  // entry; a full stop is only list punctuation when the entry is not a sentence.
  const trailing = sentence ? /[,;]+$/ : /[.,;!?]+$/
  const trim = (text: string) => text.trim().replace(trailing, '').trim()

  // Twice around, because the quotes may be inside the punctuation or outside it.
  const out = trim(unquote(trim(value)))
  return sentence ? firstSentence(out) : out
}

/**
 * Cuts text down to its first sentence, which is the one rule this step has.
 * Applied to model output rather than to what the user types — an idea being
 * assembled is allowed to be a fragment.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = /[.!?。！？]+["'”’)]*(?=\s|$)/.exec(trimmed)
  return end ? trimmed.slice(0, end.index + end[0].length) : trimmed
}

/* --- Working with the sentence itself ------------------------------------- */

export interface Token {
  text: string
  /** Position in the token list, which is what identifies a repeated word. */
  index: number
  /** Whether this is a word that can be picked, as opposed to spacing or punctuation. */
  word: boolean
}

/**
 * Words that can be picked, hyphens and apostrophes included, plus everything
 * between them. Rendering the tokens back in order must reproduce the sentence
 * exactly, so the gaps are tokens too rather than being dropped.
 *
 * Unicode-aware because the whole point is languages other than English:
 * "aujourd'hui" and "μῆλον" are single words, not four and one.
 */
const WORD = /\p{L}[\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{M}\p{N}]+)*/gu

export function tokenize(sentence: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  const push = (text: string, word: boolean) => {
    if (text) tokens.push({ text, index: tokens.length, word })
  }

  for (const match of sentence.matchAll(WORD)) {
    push(sentence.slice(cursor, match.index), false)
    push(match[0], true)
    cursor = match.index + match[0].length
  }
  push(sentence.slice(cursor), false)

  return tokens
}

/**
 * Adds a suggested word to the sentence being built.
 *
 * Drops a closing full stop first, because suggestions are picked while the
 * sentence is still growing and "Canis currit. hortus" is nobody's idea.
 */
export function appendWord(sentence: string, word: string): string {
  const base = sentence
    .trim()
    .replace(/[.!?]+$/, '')
    .trim()
  const addition = word.trim()
  if (!addition) return sentence
  return base ? `${base} ${addition}` : addition
}
