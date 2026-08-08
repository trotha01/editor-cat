/**
 * The handle between two clips, and the picker it opens.
 *
 * A boundary is the one thing on the timeline with nothing to click on: it is
 * where two clips touch and it has no width. So it gets a mark of its own,
 * sitting in the seam — a `+` where there is nothing yet, and the transition's
 * own badge where there is. It is always drawn rather than revealed on hover,
 * for the same reason the clip's ⋯ menu is: an affordance you have to already
 * know about is not one.
 *
 * The picker shows what each option does with the two shots it would actually
 * be joining, frozen halfway through. That is the whole reason for building it
 * out of `transitionStyles` rather than out of nine little pictures — the tile
 * is the same code the preview runs, so a tile can never promise something the
 * playback does not do.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPanel } from '../hooks/useAnchoredPanel'
import { useStillFrame } from '../hooks/useStillFrame'
import {
  DEFAULT_TRANSITION_DURATION,
  MIN_TRANSITION_DURATION,
  TRANSITIONS,
  clampTransitionDuration,
  formatTransitionDuration,
  transitionLabel,
  transitionStyles,
} from '../lib/transitions'
import type { Asset, Transition, TransitionKind } from '../lib/types'

/** Where the tiles are frozen: halfway, which is where a transition looks most like itself. */
const TILE_PROGRESS = 0.5

/** One shot in a tile, drawn as a picture rather than as media. See `useStillFrame`. */
function TileFrame({ still, style }: { still: string | null; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 bg-surface-2 bg-cover bg-center"
      style={{ ...(still ? { backgroundImage: `url(${still})` } : {}), ...style }}
    />
  )
}

function TransitionTile({
  kind,
  label,
  hint,
  selected,
  outgoing,
  incoming,
  onSelect,
}: {
  /** Null is the straight cut, which is drawn as the outgoing shot alone. */
  kind: TransitionKind | null
  label: string
  hint: string
  selected: boolean
  outgoing: string | null
  incoming: string | null
  onSelect: () => void
}) {
  const blend = kind ? transitionStyles(kind, TILE_PROGRESS) : null

  return (
    <button
      type="button"
      onClick={onSelect}
      title={hint}
      aria-pressed={selected}
      className="flex flex-col items-center gap-1 text-[11px] text-ink-dim"
    >
      <span
        className={`relative block aspect-square w-full overflow-hidden rounded-lg border transition ${
          selected ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-ink-dim'
        }`}
      >
        {blend?.backdrop ? (
          <span
            aria-hidden
            className="absolute inset-0"
            style={{ backgroundColor: blend.backdrop }}
          />
        ) : null}
        {/* A cut has nothing to blend: the shot before it is simply still there
            right up to the frame the next one starts on. */}
        {kind === null ? (
          <TileFrame still={outgoing} />
        ) : (
          <>
            <TileFrame still={outgoing} style={blend?.from} />
            <TileFrame still={incoming} style={blend?.to} />
          </>
        )}
      </span>
      <span className="w-full truncate text-center">{label}</span>
    </button>
  )
}

function TransitionPicker({
  transition,
  room,
  outgoing,
  incoming,
  outgoingAt,
  incomingAt,
  onChange,
  onApplyToAll,
  onClose,
}: {
  transition: Transition | null
  /** The longest this boundary can hold, worked out from both clips. */
  room: number
  outgoing: Asset | undefined
  incoming: Asset | undefined
  /** Seconds into each source to freeze for the tiles: the frames that meet. */
  outgoingAt: number
  incomingAt: number
  onChange: (transition: Transition | null) => void
  onApplyToAll: (transition: Transition | null) => void
  onClose: () => void
}) {
  const outgoingStill = useStillFrame(outgoing, outgoingAt)
  const incomingStill = useStillFrame(incoming, incomingAt)

  // What a newly picked kind lasts for: whatever this boundary is already set
  // to, so switching between kinds does not silently retime the edit.
  const duration = clampTransitionDuration(
    transition?.duration ?? DEFAULT_TRANSITION_DURATION,
    room,
  )

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">Transition</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the transition picker"
          className="rounded p-1 text-ink-dim transition hover:bg-surface-2 hover:text-ink"
        >
          <span aria-hidden>✕</span>
        </button>
      </header>

      <div className="flex flex-col gap-3 p-4">
        {/* On its own above the grid rather than as a tenth tile: it is the
            default every boundary starts at, and what the grid is an
            alternative to. */}
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={transition === null}
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
            transition === null
              ? 'border-accent bg-accent/10 text-ink ring-2 ring-accent/30'
              : 'border-line text-ink-dim hover:border-ink-dim'
          }`}
        >
          <span aria-hidden>⊘</span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-ink">Straight cut</span>
            <span className="block text-xs">No transition — one shot, then the next.</span>
          </span>
        </button>

        <div className="grid grid-cols-3 gap-2">
          {TRANSITIONS.map((entry) => (
            <TransitionTile
              key={entry.kind}
              kind={entry.kind}
              label={entry.label}
              hint={entry.hint}
              selected={transition?.kind === entry.kind}
              outgoing={outgoingStill}
              incoming={incomingStill}
              onSelect={() => onChange({ kind: entry.kind, duration })}
            />
          ))}
        </div>

        {/* Only once something has been chosen: there is no length to a cut. */}
        {transition ? (
          <label className="flex items-center gap-3 border-t border-line pt-3 text-xs text-ink-dim">
            <span className="shrink-0">Duration</span>
            <input
              type="range"
              min={MIN_TRANSITION_DURATION}
              max={Math.max(MIN_TRANSITION_DURATION, room)}
              step={0.05}
              value={transition.duration}
              disabled={room <= MIN_TRANSITION_DURATION}
              aria-label="Transition duration, in seconds"
              onChange={(event) =>
                onChange({
                  kind: transition.kind,
                  duration: clampTransitionDuration(Number(event.target.value), room),
                })
              }
              className="h-1 min-w-0 flex-1"
            />
            <span className="w-14 shrink-0 rounded bg-surface-2 px-2 py-1 text-center font-medium text-ink tabular-nums">
              {formatTransitionDuration(transition.duration)}
            </span>
          </label>
        ) : null}

        {/* The two clips either side are what caps this, and saying so is the
            difference between "the slider stops early" and a bug. */}
        <p className="text-[11px] text-ink-dim">
          Both clips give up {transition ? formatTransitionDuration(transition.duration) : 'time'}{' '}
          to a transition, so the timeline gets shorter by that much. This boundary can hold up to{' '}
          {formatTransitionDuration(room)}.
        </p>

        <button
          type="button"
          onClick={() => onApplyToAll(transition)}
          title={
            transition
              ? 'Put this transition on every boundary, as long as its clips can hold it'
              : 'Remove the transition from every boundary'
          }
          className="flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium transition hover:bg-surface-2"
        >
          <span aria-hidden>⧉</span>
          {transition ? 'Apply to all' : 'Remove from all'}
        </button>
      </div>
    </>
  )
}

export function TransitionMarker({
  transition,
  room,
  outgoing,
  incoming,
  outgoingAt,
  incomingAt,
  onChange,
  onApplyToAll,
}: {
  /** The fitted transition at this boundary, or null for a straight cut. */
  transition: Transition | null
  room: number
  outgoing: Asset | undefined
  incoming: Asset | undefined
  outgoingAt: number
  incomingAt: number
  onChange: (transition: Transition | null) => void
  onApplyToAll: (transition: Transition | null) => void
}) {
  const [open, setOpen] = useState(false)

  // Dismissing and closing differ only in where the focus lands: a press
  // somewhere else has already put it there, and pulling it back would fight
  // whatever the user just reached for.
  const dismiss = useCallback(() => setOpen(false), [])
  const {
    anchorRef: buttonRef,
    panelRef,
    position,
  } = useAnchoredPanel<HTMLButtonElement, HTMLDivElement>({
    open,
    align: 'center',
    onDismiss: dismiss,
  })

  const close = useCallback(() => {
    setOpen(false)
    buttonRef.current?.focus()
  }, [buttonRef])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open, panelRef])

  // Nothing to spare on one side or the other. The mark stays, greyed out, for
  // the reason the clip menu keeps an item it cannot run: "why can I not put one
  // here" has an answer, and this is the only place to give it.
  const roomless = !transition && room < MIN_TRANSITION_DURATION

  const label = transition
    ? `Edit the ${transitionLabel(transition.kind).toLowerCase()} between these clips, ` +
      formatTransitionDuration(transition.duration)
    : roomless
      ? 'These clips are too short for a transition — each has to spare ' +
        `${formatTransitionDuration(MIN_TRANSITION_DURATION)} of its own`
      : 'Add a transition between these clips'

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={roomless}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        // The clips either side are drag handles, so the press that opens this
        // must not also be the press that starts moving one of them.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((was) => !was)
        }}
        className={`flex h-5 items-center justify-center gap-1 rounded-full border text-[10px] font-medium shadow transition disabled:cursor-not-allowed disabled:opacity-30 ${
          transition
            ? 'border-accent bg-accent px-1.5 text-white'
            : 'border-line bg-surface px-1 text-ink-dim opacity-70 hover:opacity-100'
        }`}
      >
        {transition ? (
          <>
            <span aria-hidden>⧗</span>
            <span className="tabular-nums">{Math.round(transition.duration * 1000)}</span>
          </>
        ) : (
          <span aria-hidden className="px-0.5">
            +
          </span>
        )}
      </button>

      {open
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Transitions"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.stopPropagation()
                close()
              }}
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                // Invisible until placed, or it flashes at the corner of the
                // screen for the frame between rendering and being measured.
                visibility: position ? 'visible' : 'hidden',
              }}
              className="fixed z-50 w-72 overflow-hidden rounded-xl border border-line bg-surface shadow-xl outline-none"
            >
              <TransitionPicker
                transition={transition}
                room={room}
                outgoing={outgoing}
                incoming={incoming}
                outgoingAt={outgoingAt}
                incomingAt={incomingAt}
                onChange={onChange}
                onApplyToAll={(next) => {
                  onApplyToAll(next)
                  close()
                }}
                onClose={close}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
