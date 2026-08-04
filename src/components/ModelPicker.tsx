/**
 * Model selector with a custom-ID escape hatch.
 *
 * Provider catalogues change constantly. Without somewhere to paste an ID that
 * is not in our list, a stale registry would make the whole app unusable until
 * someone shipped a new build.
 */
import { useState } from 'react'
import { Field, Select, TextInput } from './ui'

interface Option {
  id: string
  label: string
  description?: string
}

export function ModelPicker({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string
  options: readonly Option[]
  value: string
  onChange: (id: string) => void
  hint?: string
}) {
  const known = options.some((option) => option.id === value)
  const [custom, setCustom] = useState(!known)

  const selected = options.find((option) => option.id === value)

  return (
    <div className="flex flex-col gap-2">
      <Field label={label} hint={hint}>
        {custom ? (
          <TextInput
            value={value}
            spellCheck={false}
            placeholder="e.g. fal-ai/flux/dev"
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Select value={value} onChange={(event) => onChange(event.target.value)}>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {!custom && selected?.description ? (
        <p className="text-xs leading-relaxed text-ink-dim">{selected.description}</p>
      ) : null}

      <button
        type="button"
        className="self-start text-xs text-ink-dim underline underline-offset-2 hover:text-ink"
        onClick={() => {
          const next = !custom
          setCustom(next)
          if (!next && !options.some((option) => option.id === value)) {
            onChange(options[0]?.id ?? value)
          }
        }}
      >
        {custom ? 'Choose from the list' : 'Use a custom model ID'}
      </button>
    </div>
  )
}
