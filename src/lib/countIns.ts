/**
 * Where the count-ins go, worked out from the captions.
 *
 * The captions already know when every clip starts talking — each one is
 * stamped with the clip it was heard in, and its start is the moment the first
 * word lands. So marking each clip's first word needs no new analysis of the
 * audio and no second opinion about where speech begins: it is the same
 * instant the highlight comes on over the picture, which is the one the viewer
 * is watching for anyway.
 *
 * Each mark is the same three beeps a second apart as the "Count-in beeps"
 * buttons above it — the tail runs into the word, exactly the way "Add leading
 * into" runs a count-in into the playhead. So the offset a mark is placed at is
 * measured to the *word*, not to where the beeps themselves would start.
 *
 * Each mark is carried as an **offset into its own clip** rather than as a time
 * on the timeline, and that is what makes this safe to compute before the
 * picture has finished moving. Pushing the lead-in back to fit a count-in in
 * front of the first frame slides every clip along, and every caption with it
 * (see `cuesUnderClips`), but a word two seconds into a shot is still two
 * seconds into that shot wherever the shot has gone. The caller resolves the
 * offsets against whatever layout it ends up with.
 *
 * Pure, so where a mark lands can be asserted on directly rather than by
 * listening for it.
 */
import { captionCuesOf } from './captions'
import { countdownSeconds } from './countdown'
import { layoutClips, leadInOf } from './timeline'
import type { Project } from './types'

/** One count-in, and the clip whose first word it runs into. */
export interface CountInBeep {
  /** The picture clip. The count-in is anchored to it, so it follows the shot. */
  clipId: string
  /** Seconds into that clip where its first word is heard. */
  offset: number
}

export interface CountInPlan {
  /**
   * The lead-in the picture should have once this is applied.
   *
   * The same as it is now unless the very first clip's own count-in needs more
   * room than that to fit in front of the first frame — there being nothing
   * before it to run the beeps back over, unlike every clip after it, which has
   * a shot already playing there. An existing lead-in longer than that is left
   * alone rather than pulled in to fit: it is silence somebody asked for, and
   * the count-in can sit inside it just as well.
   */
  leadIn: number
  /** One count-in per clip that has captions, in timeline order. */
  beeps: CountInBeep[]
}

/**
 * Where every count-in should run into, given the captions the project already
 * has.
 *
 * Only picture clips are marked. A caption's source may name a voiceover
 * instead — `speechSources` transcribes voice tracks as well as sound clips —
 * and a recorded take is already placed by hand at the moment it belongs at, so
 * there is nothing about it for a count-in to lead into.
 *
 * A clip with no captions gets no mark rather than one at its head: no
 * captions means either nothing is said in it or nothing has been transcribed
 * yet, and guessing that the shot starts talking on its first frame would run
 * a count-in into silence in both cases.
 */
export function planCountIns(project: Project): CountInPlan {
  // The earliest word heard in each clip. Cues are not stored in any order, so
  // this is a minimum rather than a first-one-wins.
  const firstWord = new Map<string, number>()
  for (const cue of captionCuesOf(project)) {
    const id = cue.source?.id
    if (id === undefined) continue
    const earliest = firstWord.get(id)
    if (earliest === undefined || cue.start < earliest) firstWord.set(id, cue.start)
  }

  const leadIn = leadInOf(project)
  const positioned = layoutClips(project.clips, leadIn)

  const beeps: CountInBeep[] = []
  for (const entry of positioned) {
    const start = firstWord.get(entry.clip.id)
    if (start === undefined) continue
    // Clamped at zero because a caption dragged in its own lane can be pulled
    // in front of the clip it came from, and a negative offset would put the
    // mark on the shot before this one.
    beeps.push({ clipId: entry.clip.id, offset: Math.max(0, start - entry.start) })
  }

  // Only the first clip can be short of room: every clip after it has a shot
  // already playing in front of it for the beeps to run back over, but there
  // is nothing before the first frame at all. So its own mark is the one place
  // the lead-in may have to grow — just enough to fit the three beeps ahead of
  // wherever its first word lands.
  const first = positioned[0]
  const head = beeps[0]
  const required =
    first !== undefined && head !== undefined && head.clipId === first.clip.id
      ? countdownSeconds() - head.offset
      : 0

  return { leadIn: Math.max(leadIn, required), beeps }
}
