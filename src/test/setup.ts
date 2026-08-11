import '@testing-library/jest-dom/vitest'

// jsdom does not implement the pointer-capture half of the Pointer Events
// spec (https://github.com/jsdom/jsdom/issues/2527), but every drag handle in
// the timeline — trims, the lead-in, captions, and now the scrub bar — calls
// setPointerCapture to keep a drag alive once the cursor leaves the element.
// Without a stand-in, firing a pointer event in a test throws instead of
// exercising the drag.
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  const captured = new WeakMap<Element, Set<number>>()

  Element.prototype.setPointerCapture = function (this: Element, pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>()
    ids.add(pointerId)
    captured.set(this, ids)
  }
  Element.prototype.releasePointerCapture = function (this: Element, pointerId: number) {
    captured.get(this)?.delete(pointerId)
  }
  Element.prototype.hasPointerCapture = function (this: Element, pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false
  }
}
