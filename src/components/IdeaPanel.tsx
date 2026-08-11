/**
 * Step 1: brainstorm scene ideas before generating anything.
 *
 * The rest of the pipeline needs a prompt to start from, and staring at a
 * blank "Image prompt" box is where a lot of projects stall. This tab exists
 * to give someone a pile of options instead — 20 tiny, weird scenes built
 * around one word, short enough to shoot in the 8-10 seconds a clip actually
 * gets. Picking one is a copy-paste into the Image tab, not a wired-up
 * handoff: an idea is a starting point to react to, and it should be just as
 * easy to take a phrase from the middle of one as to use it whole.
 */
import { useState } from 'react'
import { Button, Callout, Field, Spinner, TextInput } from './ui'
import { generateIdeas } from '../lib/ideaGenerator'
import { toDisplayMessage } from '../lib/errors'

export function IdeaPanel() {
  const [word, setWord] = useState('')
  const [ideas, setIdeas] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const generate = async () => {
    if (!word.trim() || busy) return
    setBusy(true)
    setError(null)
    setIdeas(null)
    try {
      setIdeas(await generateIdeas({ word }))
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(false)
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
      <Field
        label="A word to build scenes around"
        hint="Claude turns this into 20 tiny, strange scene ideas — one or two characters, not necessarily human, in a situation that wouldn't happen in real life, with a line of dialogue that uses the word."
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

      <Button
        variant="primary"
        onClick={generate}
        disabled={!word.trim() || busy}
        className="self-start"
      >
        {busy ? <Spinner /> : <span aria-hidden>💡</span>}
        {busy ? 'Generating…' : 'Generate 20 ideas'}
      </Button>

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
