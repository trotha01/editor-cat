/**
 * Asking for a clip's lines to be said properly.
 *
 * What is edited here is **the clip's captions**, not a copy of them. They are
 * saved when the button is pressed and then spoken, so the words burnt into the
 * video and the words coming out of it are the same words by construction —
 * there is no second field to keep in step, and no way to correct one and forget
 * the other.
 *
 * A line at a time, each with the moment the picture says it. That is the shape
 * of the thing being fixed: a caption knows when its line starts, so a line
 * corrected here can be spoken and laid on that mark rather than somewhere in a
 * run of speech that started right and drifted.
 *
 * A clip with no captions falls back to one text box and one piece of audio at
 * the head of the clip. It works, and it is worse, and the hint says which — the
 * captioning item is directly above this one in the same menu.
 *
 * The form closes on the press and the run reports itself beside the timeline.
 * Copying a voice and then speaking every line is several round trips, and
 * holding a modal over the editor for all of them would be holding it for
 * something the user has already finished describing.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Field, Modal, Select, TextArea, TextInput } from './ui'
import { listVoices, VOICE_LANGUAGES, type Voice } from '../lib/elevenlabs'
import { CLONE_SAMPLE_SECONDS, type FixTarget } from '../lib/clipAudioFix'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAudioFixStore, type FixRequestLine } from '../state/useAudioFixStore'
import { canUseElevenLabs, useSettingsStore } from '../state/useSettingsStore'

/** The voice option that copies the clip's own, rather than naming one. */
const CLONE_VOICE = ''

export function FixAudioDialog({
  target,
  onClose,
}: {
  /** The clip being fixed. Null when the dialog is shut. */
  target: FixTarget | null
  onClose: () => void
}) {
  const available = useSettingsStore(canUseElevenLabs)
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  // Loaded out here rather than in the form, which is remounted per clip: the
  // list belongs to the account, not to the clip, and fetching it again every
  // time a different clip's menu is used would be a request per opening.
  useEffect(() => {
    if (!target || !available || voices) return
    let cancelled = false
    listVoices()
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch((cause) => {
        // Not fatal: copying the clip's own voice needs no list, and that is
        // the option most of these clips want anyway.
        if (!cancelled) setVoiceError(toDisplayMessage(cause))
      })
    return () => {
      cancelled = true
    }
  }, [target, available, voices])

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={target ? `Fix the audio on ${target.label}` : 'Fix this clip’s audio'}
      wide
    >
      {target ? (
        // Keyed by clip, so every field starts from the clip it is describing.
        // The alternative is copying props into state in an effect, which is how
        // the last clip's line ends up being said over this one.
        <FixAudioForm
          key={target.clipId}
          target={target}
          available={available}
          voices={voices}
          voiceError={voiceError}
          onClose={onClose}
        />
      ) : null}
    </Modal>
  )
}

function FixAudioForm({
  target,
  available,
  voices,
  voiceError,
  onClose,
}: {
  target: FixTarget
  /** False only on a deployment with no ElevenLabs key of its own. */
  available: boolean
  voices: Voice[] | null
  voiceError: string | null
  onClose: () => void
}) {
  const fixClip = useAudioFixStore((state) => state.fixClip)
  // Read once, as a starting point: what was chosen last time is a better guess
  // than English-and-a-stranger, and a project is usually one language pair
  // throughout. A clip that has been fixed before overrides it with its own.
  const [language, setLanguage] = useState(
    () => target.language ?? useAudioFixStore.getState().language,
  )
  const [voiceId, setVoiceId] = useState(() => useAudioFixStore.getState().voiceId)

  /** The captions, as they are being edited. One entry per line, in order. */
  const [lines, setLines] = useState<string[]>(() => target.lines.map((line) => line.text))
  /** The whole thing as one box, for a clip with no captions to edit. */
  const [text, setText] = useState(target.text)

  const captioned = target.lines.length > 0
  const script: FixRequestLine[] = captioned
    ? target.lines.map((line, index) => ({ cueId: line.cueId, text: lines[index] ?? '' }))
    : [{ text }]
  const characters = script.reduce((total, line) => total + line.text.trim().length, 0)

  const submit = () => {
    const chosen = voices?.find((voice) => voice.voice_id === voiceId)
    void fixClip(target, {
      lines: script,
      language,
      voiceId,
      ...(chosen ? { voiceName: chosen.name } : {}),
    })
    onClose()
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-ink-dim">
        {captioned
          ? 'Correct this clip’s captions below — they are the script. Each line is saved, then said by ElevenLabs in a voice copied from the clip, and laid on the timeline where that caption starts. The captions are then re-timed to the new voice, so the highlight stays on the word being spoken.'
          : 'ElevenLabs says the line from your text, in a voice copied from this clip, and lays it on a voice track underneath.'}{' '}
        The clip’s own sound is muted in the same edit — the picture is untouched, and one undo puts
        the audio and the timings back. Your caption edits are a step of their own, so they survive
        that undo unless you press it twice.
      </p>

      {captioned ? (
        <Field
          label="This clip’s captions"
          hint="These are the real captions, not a copy: pressing the button below saves your edits to them first, then says them. Fix a spelling and both the subtitle and the voice follow."
        >
          <ul className="flex flex-col gap-2">
            {target.lines.map((line, index) => (
              <li key={line.cueId} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-right text-xs tabular-nums text-ink-dim">
                  {formatTime(line.start)}
                </span>
                <TextInput
                  value={lines[index] ?? ''}
                  aria-label={`Caption at ${formatTime(line.start)}`}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((entry, at) => (at === index ? event.target.value : entry)),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </Field>
      ) : (
        <Field
          label="What this clip should say"
          hint="This clip has no captions yet. Generate them from the same ⋯ menu first and each line gets its own mark on the timeline; without them this is spoken as one piece from the head of the clip."
          htmlFor="fix-audio-text"
        >
          <TextArea
            id="fix-audio-text"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Good morning. Buongiorno."
          />
        </Field>
      )}

      <Field
        label="Language"
        hint="Leave this on detect when the line switches languages — naming one makes the model read the whole line with that language’s mouth, English included."
        htmlFor="fix-audio-language"
      >
        <Select
          id="fix-audio-language"
          value={language}
          onChange={(event) => setLanguage(event.target.value)}
        >
          {VOICE_LANGUAGES.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Voice"
        hint={
          voiceId === CLONE_VOICE
            ? `Copied from the first ${Math.min(
                CLONE_SAMPLE_SECONDS,
                Math.max(1, Math.round(target.duration)),
              )}s of this clip, used once, then deleted again. If cloning is refused, pick a ready-made voice below instead.`
            : 'A ready-made voice. It will not sound like the clip.'
        }
        htmlFor="fix-audio-voice"
      >
        <Select
          id="fix-audio-voice"
          value={voiceId}
          onChange={(event) => setVoiceId(event.target.value)}
        >
          <option value={CLONE_VOICE}>Copy this clip’s own voice</option>
          {voices?.map((voice) => (
            <option key={voice.voice_id} value={voice.voice_id}>
              {voice.name}
            </option>
          ))}
        </Select>
      </Field>

      {voiceError ? (
        <Callout tone="warn">
          The ready-made voices could not be listed ({voiceError}) — copying this clip’s own voice
          still works.
        </Callout>
      ) : null}

      {available ? null : (
        <Callout tone="warn">
          This site is not set up for voice generation, so nothing can be said here yet. Whoever
          deployed it needs to set <code>ELEVENLABS_API_KEY</code> in the site environment. Nothing
          you can fix from here.
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={!available || characters === 0}>
          <span aria-hidden>🗣</span>{' '}
          {target.fixedAudioClipId ? 'Fix it again' : 'Save captions and fix the audio'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {/* What this will spend, in the unit ElevenLabs actually charges in.
            The bill lands on whoever deployed the site, like generation and
            captions, so the number is on screen before the press — and unlike
            those, it depends on what is typed rather than on the clip. */}
        <span className="ml-auto text-xs text-ink-dim">
          {formatTime(target.duration)} clip · {characters} characters
          {captioned ? ` · ${target.lines.length} lines` : ''}
        </span>
      </div>
    </div>
  )
}
