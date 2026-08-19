/**
 * The rubber band: the box a drag across the empty timeline sweeps out, and
 * whether a given clip fell inside it.
 *
 * Boxes rather than times and lanes, because a box is what the question really
 * is on screen. A card is where the browser laid it — floored to a minimum
 * width so a short clip stays clickable, pulled back over its neighbour by a
 * transition, and sitting on a lane whose height nothing in the model knows
 * about. Re-deriving all of that to answer "did the band cross this clip" would
 * be a second copy of the layout, and the copy that drifted would select the
 * wrong shot. So the caller reads the boxes off the elements themselves and the
 * arithmetic here is only ever two rectangles, which is what lets it be tested
 * without a browser.
 */

/** A rectangle, in whatever coordinate space the caller is working in. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * How far the pointer has to travel before a press on the background counts as
 * a marquee rather than a click. The same three pixels the lane drags use: a
 * click that moves a pixel or two is still a click, and here it is the one that
 * clears the selection rather than replacing it with an empty band.
 */
export const MARQUEE_MIN_DRAG = 3

/** The box two opposite corners bound, whichever way round they were dragged. */
export function boxFromCorners(x1: number, y1: number, x2: number, y2: number): Box {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    right: Math.max(x1, x2),
    bottom: Math.max(y1, y2),
  }
}

/**
 * True once a band is big enough to be a drag. Either axis will do: a band
 * swept flat across one lane is a perfectly ordinary thing to want, and it has
 * no height to speak of.
 */
export function isMarqueeDrag(box: Box): boolean {
  return box.right - box.left >= MARQUEE_MIN_DRAG || box.bottom - box.top >= MARQUEE_MIN_DRAG
}

/**
 * Whether two boxes share any area. Touching edges do not count, so a band
 * dragged up to a clip's edge and stopped there leaves it alone — the same rule
 * `rangesOverlap` applies to two clips meeting end to start on a lane.
 */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}
