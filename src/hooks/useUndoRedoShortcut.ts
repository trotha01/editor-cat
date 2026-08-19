/**
 * Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (and Ctrl+Y, for the Windows habit) to
 * redo. Global on the window, the same as the other single-key shortcuts,
 * because there is no one field the timeline's edits are "in".
 *
 * Told which stack to walk rather than reaching for one: the editor's edits are
 * the open project's and the word pages' are the shelf's, and both pages want
 * the same two keys to mean the same thing on whichever of them is on screen.
 */
import { useEffect } from 'react'
import { isTypingTarget } from '../lib/shortcuts'

/** Any store that keeps a history — see state/useProjectStore.ts and useWordsStore.ts. */
interface UndoableStore {
  getState: () => { undo: () => void; redo: () => void }
}

export function useUndoRedoShortcut(store: UndoableStore): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.altKey) return
      if (isTypingTarget(event.target)) return

      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        store.getState().undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        store.getState().redo()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])
}
