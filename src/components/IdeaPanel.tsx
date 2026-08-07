/** Step 1: one word becomes one sentence. */
import { useState } from 'react'
import { Button, Callout, Field, Select, Spinner, TextArea, TextInput } from './ui'
import {
  LANGUAGES,
  appendWord,
  suggestIdeas,
  suggestParts,
  tokenize,
  type PartRole,
  type Suggestion,
} from '../lib/idea'
import { toDisplayMessage } from '../lib/errors'
import { useIdeaStore } from '../state/useIdeaStore'
import { useSettingsStore } from '../state/useSettingsStore'

const ROLES: { role: PartRole; label: string; icon: string }[] = [
  { role: 'verb', label: 'Suggest verbs', icon: '🏃' },
  { role: 'object', label: 'Suggest objects', icon: '🧺' },
]

export function IdeaPanel() {
  const llmModel = useSettingsStore((state) => state.llmModel)

  const word = useIdeaStore((state) => state.word)
  const language = useIdeaStore((state) => state.language)
  const sentence = useIdeaStore((state) => state.sentence)
  const focus = useIdeaStore((state) => state.focus)
  const setWord = useIdeaStore((state) => state.setWord)
  const setLanguage = useIdeaStore((state) => state.setLanguage)
  const setSentence = useIdeaStore((state) => state.setSentence)
  const setFocus = useIdeaStore((state) => state.setFocus)

  const [busy, setBusy] = useState<PartRole | 'ideas' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parts, setParts] = useState<{ role: PartRole; items: Suggestion[] } | null>(null)
  const [ideas, setIdeas] = useState<Suggestion[] | null>(null)
  const [previous, setPrevious] = useState<string | null>(null)

  const tokens = tokenize(sentence)
  const focused = focus !== null && tokens[focus]?.word ? tokens[focus].text : null

  const askForParts = async (role: PartRole) => {
    setBusy(role)
    setError(null)
    setParts(null)
    try {
      const items = await suggestParts({ role, word, language, sentence, model: llmModel })
      setParts({ role, items })
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const askForIdeas = async () => {
    if (!focused) return
    setBusy('ideas')
    setError(null)
    setIdeas(null)
    try {
      setIdeas(await suggestIdeas({ word, language, sentence, focus: focused, model: llmModel }))
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  // Suggestions are added to the sentence rather than replacing it: they are
  // parts, and the sentence is still the user's to write. The first one lands
  // after the word itself, since a sentence built around a word that does not
  // contain it is not what anyone came here for.
  const take = (suggestion: Suggestion) =>
    setSentence(appendWord(sentence.trim() || word, suggestion.text))

  const chooseIdea = (suggestion: Suggestion) => {
    setPrevious(sentence)
    setSentence(suggestion.text)
    setIdeas(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Word" htmlFor="idea-word">
          <TextInput
            id="idea-word"
            value={word}
            placeholder="canis"
            onChange={(event) => setWord(event.target.value)}
          />
        </Field>
        <Field label="Language" htmlFor="idea-language">
          <Select
            id="idea-language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field
        label="Idea"
        htmlFor="idea-sentence"
        hint="One sentence, built around your word. The Image tab offers it as a starting prompt."
      >
        <TextArea
          id="idea-sentence"
          rows={3}
          value={sentence}
          placeholder="canis in horto dormit"
          onChange={(event) => setSentence(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        {ROLES.map((entry) => (
          <Button
            key={entry.role}
            onClick={() => askForParts(entry.role)}
            disabled={!word.trim() || busy !== null}
            title={
              word.trim() ? undefined : 'Write a word first — suggestions are built around it.'
            }
          >
            {busy === entry.role ? <Spinner /> : <span aria-hidden>{entry.icon}</span>}
            {entry.label}
          </Button>
        ))}
        {previous !== null ? (
          <Button
            variant="ghost"
            onClick={() => {
              setSentence(previous)
              setPrevious(null)
            }}
          >
            Undo
          </Button>
        ) : null}
      </div>

      {error ? (
        <Callout tone="error" title="Could not ask the model">
          {error}
        </Callout>
      ) : null}

      {parts ? (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            {parts.role === 'verb' ? 'Verbs' : 'Objects'} for “{word.trim()}”
          </p>
          <div className="flex flex-wrap gap-2">
            {parts.items.map((item) => (
              <button
                key={item.text}
                type="button"
                onClick={() => take(item)}
                className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-sm transition hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {item.text}
                {item.gloss ? <span className="text-ink-dim"> — {item.gloss}</span> : null}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-dim">Adding one puts it at the end of your sentence.</p>
        </div>
      ) : null}

      {sentence.trim() ? (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            Pick a word to explore
          </p>
          {/* Laid out as ordinary inline text rather than a flex row, so the
              spacing and punctuation between words survive intact. */}
          <p role="group" aria-label="Your idea, word by word" className="text-sm leading-loose">
            {tokens.map((token) =>
              token.word ? (
                <button
                  key={token.index}
                  type="button"
                  aria-pressed={focus === token.index}
                  onClick={() => setFocus(focus === token.index ? null : token.index)}
                  className={`rounded px-1 py-0.5 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                    focus === token.index
                      ? 'bg-accent text-accent-ink'
                      : 'underline decoration-dotted underline-offset-4 hover:bg-surface-2'
                  }`}
                >
                  {token.text}
                </button>
              ) : (
                <span key={token.index}>{token.text}</span>
              ),
            )}
          </p>

          <div>
            <Button variant="primary" onClick={askForIdeas} disabled={!focused || busy !== null}>
              {busy === 'ideas' ? <Spinner /> : <span aria-hidden>💡</span>}
              {focused ? `New ideas for “${focused}”` : 'New ideas for a word'}
            </Button>
          </div>
        </div>
      ) : null}

      {ideas ? (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            Ideas built on “{focused}”
          </p>
          <ul className="flex flex-col gap-2">
            {ideas.map((idea) => (
              <li key={idea.text} className="flex flex-col gap-1.5">
                <p className="text-sm leading-relaxed">{idea.text}</p>
                {idea.gloss ? <p className="text-xs text-ink-dim">{idea.gloss}</p> : null}
                <div>
                  <Button onClick={() => chooseIdea(idea)}>Use this</Button>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <Button variant="ghost" onClick={() => setIdeas(null)}>
              Keep mine
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
