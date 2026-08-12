/**
 * Step 1: brainstorm scene ideas before generating anything.
 *
 * The rest of the pipeline needs a prompt to start from, and staring at a
 * blank "Image prompt" box is where a lot of projects stall. This tab exists
 * to give someone a pile of options instead — tiny, weird scenes built around
 * one word, short enough to shoot in the 8-10 seconds a clip actually gets.
 * Picking one is a copy-paste into the Image tab, not a wired-up handoff: an
 * idea is a starting point to react to, and it should be just as easy to take
 * a phrase from the middle of one as to use it whole.
 *
 * The brief Claude is given is on the page and editable, rather than buried in
 * the source. What makes a good scene is a matter of taste, and the shape
 * baked in here — two characters, absurd, one line of dialogue — is only one
 * of them; someone who wants period drama or 50 ideas instead of 20 can say so
 * without waiting on a release.
 */
import { useState } from 'react'
import { Button, Callout, Field, Spinner, TextArea, TextInput } from './ui'
import { toDisplayMessage } from '../lib/errors'
import { buildIdeaSystemPrompt, MAX_IDEA_COUNT, MIN_IDEA_COUNT } from '../lib/ideaGenerator'
import { useIdeaStore } from '../state/useIdeaStore'

export function IdeaPanel() {
  const word = useIdeaStore((state) => state.word)
  const setWord = useIdeaStore((state) => state.setWord)
  const count = useIdeaStore((state) => state.count)
  const setCount = useIdeaStore((state) => state.setCount)
  const prompt = useIdeaStore((state) => state.prompt)
  const setPrompt = useIdeaStore((state) => state.setPrompt)
  const resetPrompt = useIdeaStore((state) => state.resetPrompt)
  const ideas = useIdeaStore((state) => state.ideas)
  const busy = useIdeaStore((state) => state.busy)
  const error = useIdeaStore((state) => state.error)
  const setError = useIdeaStore((state) => state.setError)
  const generate = useIdeaStore((state) => state.generate)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  // What is actually in the count box, which is briefly allowed to be empty or
  // out of range while it is being retyped — clamping on every keystroke
  // fights whoever is clearing "20" to type "5". Only a sane number reaches
  // the store; blur puts the box back in step with it.
  const [countText, setCountText] = useState(String(count))

  const editedPrompt = prompt !== buildIdeaSystemPrompt(count)

  const typeCount = (text: string) => {
    setCountText(text)
    const parsed = Number(text)
    if (Number.isInteger(parsed) && parsed >= MIN_IDEA_COUNT && parsed <= MAX_IDEA_COUNT) {
      setCount(parsed)
    }
  }

  const copy = async (idea: string, index: number) => {
    try {
      await navigator.clipboard.writeText(idea)
      setCopiedIndex(index)
      // Reverts on its own so a second copy elsewhere in the list can flash too,
      // rather than needing the first one dismissed by hand.
      setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 sm:grid-cols-[1fr_8rem]">
        <Field
          label="A word to build scenes around"
          hint={`Claude turns this into ${count} tiny, strange scene ideas — one or two characters, not necessarily human, in a situation that wouldn't happen in real life, with a line of dialogue that uses the word.`}
          htmlFor="idea-word"
        >
          <TextInput
            id="idea-word"
            value={word}
            placeholder="umbrella"
            disabled={busy}
            onChange={(event) => setWord(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void generate()
            }}
          />
        </Field>

        <Field label="How many" htmlFor="idea-count">
          <TextInput
            id="idea-count"
            type="number"
            min={MIN_IDEA_COUNT}
            max={MAX_IDEA_COUNT}
            step={1}
            value={countText}
            disabled={busy}
            onChange={(event) => typeCount(event.target.value)}
            onBlur={() => setCountText(String(count))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void generate()
            }}
          />
        </Field>
      </div>

      <Field
        label="Prompt sent to Claude"
        hint={
          editedPrompt
            ? 'Sent as written — the count box no longer rewrites it now that it has been edited.'
            : 'Edit this to change what Claude is asked for. Changing the count above rewrites it until you do.'
        }
        htmlFor="idea-prompt"
      >
        <TextArea
          id="idea-prompt"
          rows={10}
          value={prompt}
          disabled={busy}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={generate} disabled={!word.trim() || busy}>
          {busy ? <Spinner /> : <span aria-hidden>💡</span>}
          {busy ? 'Generating…' : `Generate ${count} ideas`}
        </Button>

        {editedPrompt ? (
          <Button variant="ghost" onClick={resetPrompt} disabled={busy}>
            Reset prompt
          </Button>
        ) : null}
      </div>

      {error ? (
        <Callout tone="error" title="Could not generate ideas">
          {error}
        </Callout>
      ) : null}

      {ideas ? (
        <ol className="flex flex-col gap-2">
          {ideas.map((idea, index) => (
            <li
              key={index}
              className="flex items-start gap-2 rounded-lg border border-line bg-surface p-3 text-sm leading-relaxed"
            >
              <span className="text-ink-dim tabular-nums">{index + 1}.</span>
              <p className="flex-1">{idea}</p>
              <Button variant="ghost" onClick={() => copy(idea, index)}>
                {copiedIndex === index ? 'Copied' : 'Copy'}
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
