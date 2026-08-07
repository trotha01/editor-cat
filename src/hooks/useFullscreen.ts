import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Fullscreen for one element of our choosing.
 *
 * The preview is not a `<video>` — it is a stack of media elements chased to a
 * clock that lives above them — so the browser's own video fullscreen is no use
 * here: it would show whichever clip happened to be on screen and leave the
 * player behind. Fullscreening the container keeps the whole thing intact,
 * including the audio elements and the transport, and nothing is remounted, so
 * playback carries straight on across the transition.
 *
 * Two things are deliberately asked rather than assumed:
 *
 * - **Whether it can be done at all.** Safari still only has the prefixed API;
 *   an iframe without `allow="fullscreen"` has none; an iPhone has none for
 *   anything but a bare `<video>`. Where the answer is no, the caller hides the
 *   button, because one that can only fail is worse than no button.
 * - **Whether we are in it.** Leaving is often not our doing — Escape and the
 *   browser's own chrome both exit without asking — so the flag is read back
 *   off the document on every change event rather than tracked as we go.
 */

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

interface PrefixedDocument extends Document {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

function fullscreenElement(): Element | null {
  const doc = document as PrefixedDocument
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

function fullscreenAllowed(): boolean {
  const doc = document as PrefixedDocument
  return Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled)
}

export interface Fullscreen<T extends HTMLElement> {
  /** Attach to the element that should fill the screen. */
  ref: React.RefObject<T | null>
  /** True only while *this* element is the one filling the screen. */
  active: boolean
  /** False where the browser or the embedding refuses fullscreen outright. */
  supported: boolean
  toggle: () => void
}

export function useFullscreen<T extends HTMLElement>(): Fullscreen<T> {
  const ref = useRef<T>(null)
  const [active, setActive] = useState(false)
  // Read once, lazily: it cannot change for the life of the document, and a
  // button that appeared a frame late would be worse than one that never did.
  const [supported] = useState(fullscreenAllowed)

  useEffect(() => {
    const sync = () => setActive(ref.current !== null && fullscreenElement() === ref.current)

    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    // Another element may already hold the screen, so do not assume false.
    sync()

    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  const toggle = useCallback(() => {
    const element = ref.current as PrefixedElement | null
    if (!element) return

    const doc = document as PrefixedDocument
    const leaving = fullscreenElement() === element
    const request = leaving
      ? (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.bind(doc)
      : (element.requestFullscreen ?? element.webkitRequestFullscreen)?.bind(element)
    if (!request) return

    // A refusal — a permissions policy, a gesture the browser did not count —
    // leaves the preview exactly as it was, which is a fine place to be. The
    // flag is not touched here either way: `fullscreenchange` is the only thing
    // that gets to say where we ended up.
    void Promise.resolve(request()).catch(() => undefined)
  }, [])

  return { ref, active, supported, toggle }
}
