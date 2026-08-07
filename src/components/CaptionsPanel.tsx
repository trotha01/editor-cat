/**
 * Step 4: captions, karaoke style.
 *
 * One button transcribes what is on the timeline; everything after it is
 * editing. The transcript is the editing surface, not the timeline — you fix a
 * misheard word by retyping it in a line of text, the way you would fix a typo,
 * and the timings of every other word in that line survive untouched (see
 * `setCueText`). The timeline lane is for the other half of the job: when a
 * highlight lands a beat off the voice, that is a timing you drag, not a word
 * you retype.
 *
 * Word timings are what make this karaoke rather than subtitles, so they are
 * first-class here: every word is a chip you can click to hear, select, and
 * retime to the hundredth of a second, and the chip that is lit is the word that
 * is lit in the preview.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Callout, EmptyState, Field, Select, Spinner, TextArea } from './ui'
import {
  activeWordIndexAt,
  captionCuesOf,
  captionTracksOf,
  cueText,
  cuesOnTrack,
  splitBoundary,
} from '../lib/captions'
import { speechSources } from '../lib/captionSources'
import { SPEECH_LANGUAGES } from '../lib/scribe'
import { transcribeTimeline, type TranscribeProgress } from '../lib/transcribeTimeline'
import { formatTime } from '../lib/timeline'
import { toDisplayMessage } from '../lib/errors'
import { useAssetStore } from '../state/useAssetStore'
import { useProjectStore } from '../state/useProjectStore'
import type { CaptionCue, CaptionStyle, CaptionTrack } from '../lib/types'

export function CaptionsPanel({
  currentTime,
  onSeek,
}: {
  currentTime: number
  onSeek: (time: number) => void
}) {
  const project = useProjectStore((state) => state.project)
  const ensureCaptionTrack = useProjectStore((state) => state.ensureCaptionTrack)
  const setCaptionsFromWords = useProjectStore((state) => state.setCaptionsFromWords)
  const assets = useAssetStore((state) => state.assets)

  const [language, setLanguage] = useState('')
  const [progress, setProgress] = useState<TranscribeProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const tracks = captionTracksOf(project)
  const cues = captionCuesOf(project)
  const track = tracks[0]

  const sources = useMemo(() => speechSources(project, assets), [project, assets])
  const speechSeconds = sources.reduce((sum, source) => sum + source.duration, 0)

  const run = async () => {
    setError(null)
    setNotice(null)
    setWarnings([])
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const trackId = ensureCaptionTrack()
      const transcript = await transcribeTimeline({
        sources,
        assets,
        ...(language ? { languageCode: language } : {}),
        onProgress: setProgress,
        signal: controller.signal,
      })

      const count = setCaptionsFromWords(trackId, transcript.words)
      setWarnings(transcript.failures)
      setNotice(
        count === 0
          ? 'No speech was recognised in the audio on the timeline.'
          : `${count} caption${count === 1 ? '' : 's'} from ${transcript.words.length} words` +
              (transcript.languages.length > 0
                ? ` · heard as ${transcript.languages.join(', ')}`
                : ''),
      )
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(toDisplayMessage(cause))
      }
    } finally {
      setProgress(null)
      abortRef.current = null
    }
  }

  const busy = progress !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium">Karaoke captions</p>
        <p className="text-xs leading-relaxed text-ink-dim">
          Transcribes the voice tracks and the sound your video clips carry, then puts one caption
          at a time on screen with the word being spoken picked out. Edit the words below; drag the
          captions and their word marks on the timeline.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Spoken language">
            <Select
              value={language}
              disabled={busy}
              onChange={(event) => setLanguage(event.target.value)}
              aria-label="Which language is spoken"
            >
              {SPEECH_LANGUAGES.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <p className="text-xs leading-relaxed text-ink-dim">
          Transcribed by ElevenLabs Scribe, which times every word — that timing is what the
          highlight follows. It runs on this site&apos;s own account, so it needs no key from you.
          Only the audio is sent, separated from the picture first.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={busy || sources.length === 0}
            title={
              sources.length === 0
                ? 'Record a voiceover, or add a video clip with sound, first.'
                : `Transcribe ${formatTime(speechSeconds)} of audio from ${sources.length} source${
                    sources.length === 1 ? '' : 's'
                  }`
            }
          >
            {busy ? <Spinner /> : <span aria-hidden>💬</span>}
            {cues.length > 0 ? 'Redo captions' : 'Add captions'}
          </Button>

          {sources.length === 0 ? (
            <span className="text-xs text-ink-dim">
              Nothing to transcribe yet — record a voiceover on the Audio step, or put a video clip
              with its own sound on the timeline.
            </span>
          ) : null}
        </div>

        {busy ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs text-ink-dim">
              <span>
                Transcribing {Math.min(progress.done + 1, progress.total)} of {progress.total}
                {progress.label ? ` · ${progress.label}` : ''}
                {progress.detail ? ` · ${progress.detail}` : ''}
              </span>
              <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            </div>
            {/* The model download is the one part with a real total, and it is
                also the long silent wait, so it gets a bar of its own. */}
            {progress.ratio === undefined ? null : (
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full bg-accent transition-[width]"
                  style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                />
              </div>
            )}
          </div>
        ) : null}

        {cues.length > 0 && !busy ? (
          <p className="text-xs text-ink-dim">
            Redoing replaces the captions below. Anything you have edited by hand will be lost.
          </p>
        ) : null}
      </div>

      {notice ? <Callout tone="success">{notice}</Callout> : null}
      {warnings.length > 0 ? (
        <Callout tone="warn" title="Some audio could not be transcribed">
          <ul className="list-inside list-disc">
            {warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {error ? <Callout tone="error">{error}</Callout> : null}

      {track ? <CaptionStyleControls track={track} /> : null}

      {track && cues.length > 0 ? (
        <TranscriptEditor
          cues={cuesOnTrack(cues, track.id)}
          currentTime={currentTime}
          onSeek={onSeek}
        />
      ) : (
        <EmptyState icon="💬" title="No captions yet">
          Press “Add captions” and the words on your timeline become an editable transcript, with
          one highlighted at a time over the picture.
        </EmptyState>
      )}
    </div>
  )
}

/** How captions look. Every value is a fraction of the frame, so it survives a resolution change. */
function CaptionStyleControls({ track }: { track: CaptionTrack }) {
  const setCaptionStyle = useProjectStore((state) => state.setCaptionStyle)
  const set = (patch: Partial<CaptionStyle>) => setCaptionStyle(track.id, patch)
  const { style } = track

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3">
      <p className="text-sm font-medium">Look</p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs text-ink-dim">
          Size
          <input
            type="range"
            min={0.03}
            max={0.16}
            step={0.005}
            value={style.fontScale}
            onChange={(event) => set({ fontScale: Number(event.target.value) })}
            aria-label="Caption size, as a fraction of the frame height"
            title={`${Math.round(style.fontScale * 100)}% of the frame height`}
            className="h-1 w-28"
          />
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-dim">
          Height
          <input
            type="range"
            min={0.1}
            max={0.95}
            step={0.01}
            value={style.position}
            onChange={(event) => set({ position: Number(event.target.value) })}
            aria-label="How far down the frame the captions sit"
            title={`${Math.round(style.position * 100)}% down the frame`}
            className="h-1 w-28"
          />
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={style.bold}
            onChange={(event) => set({ bold: event.target.checked })}
          />
          Bold
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={style.uppercase}
            onChange={(event) => set({ uppercase: event.target.checked })}
          />
          UPPERCASE
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <ColorField label="Words" value={style.color} onChange={(color) => set({ color })} />
        <ColorField
          label="Highlight"
          value={style.highlightColor}
          onChange={(highlightColor) => set({ highlightColor })}
        />
        <ColorField
          label="Outline"
          value={style.outlineColor}
          onChange={(outlineColor) => set({ outlineColor })}
        />
      </div>
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-ink-dim">
      {label}
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`${label} colour`}
        className="size-6 cursor-pointer rounded border border-line bg-surface-2 p-0.5"
      />
    </label>
  )
}

/** The transcript: every caption, editable, with the spoken word lit as it plays. */
function TranscriptEditor({
  cues,
  currentTime,
  onSeek,
}: {
  cues: readonly CaptionCue[]
  currentTime: number
  onSeek: (time: number) => void
}) {
  const selected = useProjectStore((state) => state.selectedCaption)
  const containerRef = useRef<HTMLUListElement>(null)

  const playingCue = cues.find((cue) => currentTime >= cue.start && currentTime < cue.end)

  // Follow playback, but never steal the view from someone typing in it: the
  // playhead runs on while you edit, and a panel that scrolls out from under
  // the cursor is worse than one that does not follow at all.
  useEffect(() => {
    const container = containerRef.current
    if (!container || !playingCue) return
    if (container.contains(document.activeElement)) return
    container
      .querySelector(`[data-cue="${playingCue.id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [playingCue])

  return (
    <ul
      ref={containerRef}
      className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto"
      aria-label="Transcript"
    >
      {cues.map((cue, index) => (
        <CueEditor
          key={cue.id}
          cue={cue}
          index={index}
          playing={playingCue?.id === cue.id}
          selected={selected?.cueId === cue.id}
          selectedWordId={selected?.cueId === cue.id ? selected.wordId : null}
          currentTime={currentTime}
          onSeek={onSeek}
        />
      ))}
    </ul>
  )
}

function CueEditor({
  cue,
  index,
  playing,
  selected,
  selectedWordId,
  currentTime,
  onSeek,
}: {
  cue: CaptionCue
  index: number
  playing: boolean
  selected: boolean
  selectedWordId: string | null
  currentTime: number
  onSeek: (time: number) => void
}) {
  const selectCaption = useProjectStore((state) => state.selectCaption)
  const setCueTextAt = useProjectStore((state) => state.setCueTextAt)
  const splitCueAt = useProjectStore((state) => state.splitCueAt)
  const mergeCueBack = useProjectStore((state) => state.mergeCueBack)
  const respaceCue = useProjectStore((state) => state.respaceCue)
  const removeCue = useProjectStore((state) => state.removeCue)
  const setCueWordTiming = useProjectStore((state) => state.setCueWordTiming)

  const text = cueText(cue)
  const activeIndex = playing ? activeWordIndexAt(cue, currentTime) : -1
  const selectedIndex = cue.words.findIndex((word) => word.id === selectedWordId)
  const selectedWord = cue.words[selectedIndex]

  return (
    <li
      data-cue={cue.id}
      className={`flex flex-col gap-2 rounded-xl border bg-surface p-3 ${
        playing ? 'border-accent' : selected ? 'border-accent/40' : 'border-line'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSeek(cue.start)}
          className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-dim hover:text-ink"
          title="Jump the playhead here"
        >
          {formatTime(cue.start)}
        </button>
        <span className="text-[11px] text-ink-dim">
          {cue.words.length} word{cue.words.length === 1 ? '' : 's'} ·{' '}
          {(cue.end - cue.start).toFixed(1)}s
        </span>

        <div className="ml-auto flex items-center gap-1">
          {index > 0 ? (
            <Button
              variant="ghost"
              className="!px-1.5 !py-0.5 text-xs"
              onClick={() => mergeCueBack(cue.id)}
              title="Join this caption onto the one above"
            >
              ⤒ Join up
            </Button>
          ) : null}
          <Button
            variant="ghost"
            className="!px-1.5 !py-0.5 text-xs"
            onClick={() => respaceCue(cue.id)}
            title="Space these words evenly across the caption — the repair for a line you rewrote"
          >
            Respace
          </Button>
          <Button
            variant="ghost"
            className="!px-1.5 !py-0.5 text-xs"
            onClick={() => removeCue(cue.id)}
            aria-label={`Delete caption ${index + 1}`}
          >
            🗑
          </Button>
        </div>
      </div>

      {/* Uncontrolled, and committed on the way out rather than per keystroke.
          Re-deriving words from a half-typed line would remake their ids under
          the cursor — losing the selection, and with it the timing controls you
          were about to use. `key` is the text itself, so a commit (or an edit
          made anywhere else) remounts this with the new line and nothing has to
          be kept in sync by hand. */}
      <TextArea
        key={text}
        defaultValue={text}
        rows={Math.min(3, Math.ceil(text.length / 44))}
        aria-label={`Caption ${index + 1} text`}
        onFocus={() => selectCaption({ cueId: cue.id, wordId: null })}
        onBlur={(event) => {
          if (event.target.value.trim() === text.trim()) return
          setCueTextAt(cue.id, event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            event.currentTarget.value = text
            event.currentTarget.blur()
          }
        }}
        className="!py-1.5 text-sm"
      />

      {/* The words as they are timed. This row is the karaoke itself: the chip
          that is lit here is the word that is lit over the picture. */}
      <div className="flex flex-wrap gap-1">
        {cue.words.map((word, wordIndex) => (
          <button
            key={word.id}
            type="button"
            onClick={() => {
              selectCaption({ cueId: cue.id, wordId: word.id })
              onSeek(word.start)
            }}
            title={`${formatTime(word.start)} — click to hear it, then retime it below`}
            className={`rounded px-1.5 py-0.5 text-xs transition ${
              wordIndex === activeIndex
                ? 'bg-accent text-accent-ink'
                : word.id === selectedWordId
                  ? 'bg-accent/20 text-ink ring-1 ring-accent'
                  : 'bg-surface-2 text-ink-dim hover:text-ink'
            }`}
          >
            {word.text}
          </button>
        ))}
      </div>

      {selectedWord ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-2.5 py-2">
          <span className="text-xs font-medium">“{selectedWord.text}”</span>
          <SecondsInput
            label="Highlights at"
            title={`When "${selectedWord.text}" is highlighted, in seconds`}
            seconds={selectedWord.start}
            onCommit={(start) => setCueWordTiming(cue.id, selectedWord.id, { start })}
          />
          <SecondsInput
            label="until"
            title={`When "${selectedWord.text}" stops being spoken, in seconds`}
            seconds={selectedWord.end}
            onCommit={(end) => setCueWordTiming(cue.id, selectedWord.id, { end })}
          />
          {/* Offered only where a break can actually land: both halves have to
              be long enough to read, so two words a heartbeat apart cannot
              become two captions. */}
          {splitBoundary(cue, selectedIndex) !== null ? (
            <Button
              variant="ghost"
              className="!px-1.5 !py-0.5 text-xs"
              onClick={() => splitCueAt(cue.id, selectedIndex)}
              title="Start a new caption at this word"
            >
              ✂ Break here
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/**
 * A time in seconds, committed when you have finished typing it.
 *
 * Every keystroke would otherwise be a retime, and each one is clamped against
 * the word's neighbours — so clearing the field to type a new number commits
 * `0`, which clamps to the earliest allowed time and moves the word before you
 * have typed a digit. Committing on the way out lets the field hold a
 * half-written number without the model seeing it.
 *
 * `key` is the committed value, so a clamp — or an edit made on the timeline —
 * remounts this with what actually landed rather than leaving what was typed.
 */
function SecondsInput({
  label,
  title,
  seconds,
  onCommit,
}: {
  label: string
  title: string
  seconds: number
  onCommit: (seconds: number) => void
}) {
  const text = seconds.toFixed(2)

  const commit = (value: string) => {
    const parsed = Number(value)
    // An emptied or nonsense field means "leave it alone", not "move it to zero".
    if (value.trim() === '' || !Number.isFinite(parsed)) return
    if (parsed !== seconds) onCommit(parsed)
  }

  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-dim">
      {label}
      <input
        key={text}
        type="number"
        step={0.01}
        defaultValue={text}
        aria-label={title}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = text
            event.currentTarget.blur()
          }
        }}
        className="w-20 rounded border border-line bg-surface px-1.5 py-0.5 text-xs text-ink"
      />
      s
    </label>
  )
}
