/**
 * Where the beeps go, worked out from the captions.
 *
 * The captions already know when every clip starts talking — each one is
 * stamped with the clip it was heard in, and its start is the moment the first
 * word lands. So marking each clip's first word with a beep needs no new
 * analysis of the audio and no second opinion about where speech begins: it is
 * the same instant the highlight comes on over the picture, which is the one
 * the viewer is watching for anyway.
 *
 * Each beep is measured as an **offset into its own clip** rather than as a
 * time on the timeline, and that is what makes this safe to compute before the
 * picture has finished moving. Pushing the lead-in back to fit a count-in in
 * front of the first frame slides every clip along, and every caption with it
 * (see `cuesUnderClips`), but a word two seconds into a shot is still two
 * seconds into that shot wherever the shot has gone. The caller resolves the
 * offsets against whatever layout it ends up with.
 *
 * Pure, so where a beep lands can be asserted on directly rather than by
 * listening for it.
 */
import { captionCuesOf } from './captions'
import { countdownSeconds } from './countdown'
import { layoutClips, leadInOf } from './timeline'
import type { Project } from './types'

/**
 * How little silence in front of the first word counts as "talking from the
 * off", and so as needing a count-in ahead of the picture.
 *
 * Half a second is not a run-up by any reading — it is over before anyone has
 * registered that the video started. A clip that waits longer than this has
 * already given the viewer their beat, and putting three beeps in front of it
 * would be answering a question nobody asked.
 */
export const OPENING_SILENCE = 0.5

/** One beep, and the clip whose first word it marks. */
export interface CountInBeep {
  /** The picture clip. The beep is anchored to it, so it follows the shot. */
  clipId: string
  /** Seconds into that clip where its first word is heard. */
  offset: number
}

export interface CountInPlan {
  /**
   * Where the three-beep count-in runs into the first frame, or null when the
   * first clip does not start talking straight away and so has nothing to be
   * counted into.
   */
  opening: number | null
  /**
   * The lead-in the picture should have once this is applied.
   *
   * The same as it is now unless a count-in has to fit in front of it. An
   * existing lead-in longer than the count-in is left alone rather than pulled
   * in to fit: it is silence somebody asked for, and the beeps can sit inside
   * it just as well at the end.
   */
  leadIn: number
  /** One beep per clip that has captions, in timeline order. */
  beeps: CountInBeep[]
}

/**
 * Where every beep should sound, given the captions the project already has.
 *
 * Only picture clips are marked. A caption's source may name a voiceover
 * instead — `speechSources` transcribes voice tracks as well as sound clips —
 * and a recorded take is already placed by hand at the moment it belongs at, so
 * there is nothing about it for a beep to announce.
 *
 * A clip with no captions gets no beep rather than a beep at its head: no
 * captions means either nothing is said in it or nothing has been transcribed
 * yet, and guessing that the shot starts talking on its first frame would put a
 * beep over silence in both cases.
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
    // beep on the shot before this one.
    beeps.push({ clipId: entry.clip.id, offset: Math.max(0, start - entry.start) })
  }

  const first = positioned[0]
  const head = beeps[0]
  const opensTalking =
    first !== undefined &&
    head !== undefined &&
    head.clipId === first.clip.id &&
    head.offset <= OPENING_SILENCE

  if (!opensTalking) return { opening: null, leadIn, beeps }

  const counted = Math.max(leadIn, countdownSeconds())
  // Placed so its tail meets the first frame, wherever that has ended up. With
  // no lead-in yet that is time zero, which is the same place the Audio step's
  // own "before the video" button puts one; with a longer lead-in already set
  // it is later, so the beeps still run into the picture rather than into the
  // silence somebody left in front of it.
  return { opening: counted - countdownSeconds(), leadIn: counted, beeps }
}
