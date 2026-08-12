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

/**
 * `<dialog>`, which jsdom knows the element but not the methods of.
 *
 * `showModal` and `close` are simply absent — calling one throws
 * "dialog.showModal is not a function" — so any component built on the shared
 * `Modal` blows up on mount rather than rendering. Nothing about that is a fact
 * worth testing; it is the environment missing an implementation, and this is
 * the smallest stand-in that makes `open` mean what the real element means.
 *
 * Deliberately not a full one: no top layer, no focus trapping, no backdrop, no
 * inertness for the rest of the page. A test that needs those is testing the
 * browser.
 */
const dialog = window.HTMLDialogElement.prototype

if (!dialog.showModal) {
  dialog.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  dialog.show = function show(this: HTMLDialogElement) {
    this.open = true
  }
  dialog.close = function close(this: HTMLDialogElement, returnValue?: string) {
    this.open = false
    if (returnValue !== undefined) this.returnValue = returnValue
    // The event React's `onClose` is waiting for. Without it a dialog closed by
    // its own close button never tells the state that owns it.
    this.dispatchEvent(new window.Event('close'))
  }
}
