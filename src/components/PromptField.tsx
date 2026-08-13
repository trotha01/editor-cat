/**
 * A prompt box with an "Improve with AI" button.
 *
 * The improved prompt is shown *next to* the original rather than silently
 * replacing it. Prompt rewriting frequently drifts from what the user meant,
 * and having to retype a lost prompt is exactly the kind of small betrayal that
 * makes a feature like this annoying instead of useful.
 */
import { useState } from 'react'
import { Button, Callout, Field, Spinner, TextArea } from './ui'
import { enhancePrompt, type EnhanceKind } from '../lib/promptEnhancer'
import { toDisplayMessage } from '../lib/errors'

interface Props {
  kind: EnhanceKind
  label: string
  placeholder: string
  hint?: string
  value: string
  onChange: (value: string) => void
  rows?: number
  disabled?: boolean
}

export function PromptField({
  kind,
  label,
  placeholder,
  hint,
  value,
  onChange,
  rows = 4,
  disabled,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const [previous, setPrevious] = useState<string | null>(null)

  const canEnhance = value.trim().length > 0 && !disabled

  const improve = async () => {
    setBusy(true)
    setError(null)
    setSuggestion(null)
    try {
      const improved = await enhancePrompt({ kind, prompt: value })
      setSuggestion(improved)
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const accept = () => {
    if (!suggestion) return
    setPrevious(value)
    onChange(suggestion)
    setSuggestion(null)
  }

  const undo = () => {
    if (previous === null) return
    onChange(previous)
    setPrevious(null)
  }

  const id = `prompt-${kind}`

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint} htmlFor={id}>
        <TextArea
          id={id}
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={improve} disabled={!canEnhance || busy}>
          {busy ? <Spinner /> : <span aria-hidden>✨</span>}
          {busy ? 'Improving…' : 'Improve with AI'}
        </Button>
        {previous !== null ? (
          <Button variant="ghost" onClick={undo}>
            Undo improvement
          </Button>
        ) : null}
      </div>

      {error ? (
        <Callout tone="error" title="Could not improve the prompt">
          {error}
        </Callout>
      ) : null}

      {suggestion ? (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            Suggested {kind} prompt
          </p>
          <p className="text-sm leading-relaxed">{suggestion}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={accept}>
              Use this
            </Button>
            <Button variant="ghost" onClick={() => setSuggestion(null)}>
              Keep mine
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
