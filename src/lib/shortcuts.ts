/**
 * Rules shared by the editor's keyboard shortcuts.
 *
 * Shortcuts listen on the window so they work wherever the pointer happens to
 * be — which is also what makes this guard necessary. The prompt boxes are full
 * of the same characters the shortcuts use, and a space bar that pauses
 * playback instead of typing a space is a bug you notice mid-sentence.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}
