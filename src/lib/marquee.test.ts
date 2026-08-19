import { describe, expect, it } from 'vitest'
import { MARQUEE_MIN_DRAG, boxFromCorners, boxesOverlap, isMarqueeDrag } from './marquee'

describe('boxFromCorners', () => {
  it('bounds the two corners whichever way round they were dragged', () => {
    const forwards = boxFromCorners(10, 20, 40, 60)
    const backwards = boxFromCorners(40, 60, 10, 20)

    expect(forwards).toEqual({ left: 10, top: 20, right: 40, bottom: 60 })
    // Dragging up and to the left is the same band as dragging down and to the
    // right across the same two points, which is the whole reason this exists.
    expect(backwards).toEqual(forwards)
  })
})

describe('isMarqueeDrag', () => {
  it('takes either axis on its own', () => {
    // A band swept flat along one lane has no height worth the name, and is
    // exactly what somebody selecting a row of clips draws.
    expect(isMarqueeDrag(boxFromCorners(0, 0, MARQUEE_MIN_DRAG, 0))).toBe(true)
    expect(isMarqueeDrag(boxFromCorners(0, 0, 0, MARQUEE_MIN_DRAG))).toBe(true)
  })

  it('leaves a press that only wobbled as a click', () => {
    expect(isMarqueeDrag(boxFromCorners(0, 0, MARQUEE_MIN_DRAG - 1, MARQUEE_MIN_DRAG - 1))).toBe(
      false,
    )
  })
})

describe('boxesOverlap', () => {
  const clip = { left: 100, top: 0, right: 200, bottom: 40 }

  it('catches a band that crosses part of a clip', () => {
    expect(boxesOverlap(boxFromCorners(150, 10, 400, 30), clip)).toBe(true)
  })

  it('catches a band drawn entirely inside a clip', () => {
    expect(boxesOverlap(boxFromCorners(120, 10, 140, 20), clip)).toBe(true)
  })

  it('misses a clip on another row of the same stretch of time', () => {
    expect(boxesOverlap(boxFromCorners(100, 60, 200, 90), clip)).toBe(false)
  })

  it('misses a clip the band was drawn up to and stopped at', () => {
    // Touching is not overlapping, the same rule two clips meeting end to start
    // on a lane are judged by.
    expect(boxesOverlap(boxFromCorners(0, 0, 100, 40), clip)).toBe(false)
  })
})
