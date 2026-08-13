/**
 * Files dragged in off the desktop and dropped on one part of the page.
 *
 * This is the browser's own drag and drop, which is a different mechanism from
 * the dnd-kit drags that reorder a run: those are pointer events that never
 * leave the page, these only exist between the desktop and a drop target. The
 * two look alike from here, so every handler starts by asking whether the drag
 * is carrying files at all — a take being dragged up the list must not light up
 * the word column as somewhere to drop it.
 *
 * `over` is counted rather than simply set and cleared, because `dragleave`
 * fires every time the pointer crosses into a child element. Without the depth
 * count a zone with anything inside it flickers the whole way across.
 */
import { useRef, useState, type DragEvent, type DragEventHandler } from 'react'

/** What the four handlers spread onto whichever element is the target. */
export interface DropProps {
  onDragEnter: DragEventHandler
  onDragOver: DragEventHandler
  onDragLeave: DragEventHandler
  onDrop: DragEventHandler
}

/** True when the thing being dragged is files rather than anything else. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

export function useFileDrop(
  onFiles: (files: File[]) => void,
  /** Turns the zone off without changing where it is — an upload already running. */
  disabled = false,
): { over: boolean; dropProps: DropProps } {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const leave = () => {
    depth.current = 0
    setOver(false)
  }

  return {
    over,
    dropProps: {
      onDragEnter: (event) => {
        if (disabled || !carriesFiles(event)) return
        depth.current += 1
        setOver(true)
      },
      onDragOver: (event) => {
        if (disabled || !carriesFiles(event)) return
        // The whole of what makes an element a drop target: without this the
        // browser refuses the drop and opens the file over the page instead.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (event) => {
        if (disabled || !carriesFiles(event)) return
        depth.current -= 1
        if (depth.current <= 0) leave()
      },
      onDrop: (event) => {
        if (disabled || !carriesFiles(event)) return
        event.preventDefault()
        leave()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) onFiles(files)
      },
    },
  }
}
