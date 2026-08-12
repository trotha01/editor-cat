/**
 * Asking for a clip's line to be said properly.
 *
 * Three questions, and each one is here because getting it wrong is a real way
 * for the result to be useless: what the clip should say, spelled the way it
 * should be pronounced; which language that is, or none if the line switches
 * between two; and whose voice says it.
 *
 * The text box opens with what this clip's captions heard, so the common case
 * is correcting a word rather than typing a line out. That is also the honest
 * order to work in — caption the clip, read what came back, fix what is wrong —
 * and both items sit in the same ⋯ menu, one under the other.
 *
 * The form closes on the press and the run reports itself beside the timeline.
 * Copying a voice and then speaking a line is two round trips, and holding a
 * modal over the editor for both of them would be holding it for something the
 * user has already finished describing.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Field, Modal, Select, TextArea } from './ui'
import { listVoices, VOICE_LANGUAGES, type Voice } from '../lib/elevenlabs'
import { CLONE_SAMPLE_SECONDS, type FixTarget } from '../lib/clipAudioFix'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAudioFixStore } from '../state/useAudioFixStore'
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
  /** False only on a deployment with no key of its own and none entered. */
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
  const [text, setText] = useState(target.text)

  const submit = () => {
    const chosen = voices?.find((voice) => voice.voice_id === voiceId)
    void fixClip(target, {
      text,
      language,
      voiceId,
      ...(chosen ? { voiceName: chosen.name } : {}),
    })
    onClose()
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-ink-dim">
        ElevenLabs says the line again from your text, in a voice copied from this clip, and lays it
        on a voice track underneath. The clip’s own sound is muted in the same edit — the picture is
        untouched, and one undo puts both back.
      </p>

      <Field
        label="What this clip should say"
        hint={
          target.text
            ? 'Started from this clip’s captions. Correct the spelling of anything that came out wrong — this is exactly what will be said.'
            : 'Nothing has been transcribed from this clip yet. Type the line, or close this and generate captions for the clip first.'
        }
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
        <Button variant="primary" onClick={submit} disabled={!available || !text.trim()}>
          <span aria-hidden>🗣</span>{' '}
          {target.fixedAudioClipId ? 'Fix it again' : 'Fix this clip’s audio'}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {/* What this will spend, in the unit ElevenLabs actually charges in.
            The bill lands on whoever deployed the site, like generation and
            captions, so the number is on screen before the press — and unlike
            those, it depends on what is typed rather than on the clip. */}
        <span className="ml-auto text-xs text-ink-dim">
          {formatTime(target.duration)} clip · {text.trim().length} characters
        </span>
      </div>
    </div>
  )
}
