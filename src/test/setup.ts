import '@testing-library/jest-dom/vitest'

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
