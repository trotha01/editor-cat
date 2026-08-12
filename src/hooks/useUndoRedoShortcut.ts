/**
 * Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (and Ctrl+Y, for the Windows habit) to
 * redo. Global on the window, the same as the other single-key shortcuts,
 * because there is no one field the timeline's edits are "in".
 */
import { useEffect } from 'react'
import { isTypingTarget } from '../lib/shortcuts'
import { useProjectStore } from '../state/useProjectStore'

export function useUndoRedoShortcut(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.altKey) return
      if (isTypingTarget(event.target)) return

      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        useProjectStore.getState().undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        useProjectStore.getState().redo()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
