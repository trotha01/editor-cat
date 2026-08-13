/**
 * Which page the address bar is asking for.
 *
 * The app is two pages now — the editor, and the word pages — so it needs some
 * way of being asked for one. That is the whole of what this does: no router, no
 * nested routes, no history stack of its own.
 *
 * In the hash rather than the path for two reasons. Auth0 comes back from Google
 * to this same URL carrying `code` and `state` in the *query* string, and the
 * auth store consumes them on mount — a path-based route would have to be
 * preserved across that return, while the hash is untouched by it. And a hash
 * needs no `pushState`, so the back button works without anything here
 * intercepting it.
 */
import { useSyncExternalStore } from 'react'

export type Route = 'editor' | 'words'

export const EDITOR_HASH = '#/'
export const WORDS_HASH = '#/words'

/** Anything unrecognised is the editor, which is what a bare URL asks for. */
export function routeFromHash(hash: string): Route {
  return hash.replace(/^#\/?/, '').toLowerCase() === 'words' ? 'words' : 'editor'
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/**
 * The current route, re-read whenever the hash changes.
 *
 * `useSyncExternalStore` rather than an effect and a piece of state, because the
 * hash is exactly what it is for: something outside React that React has to
 * agree with on the very first render, including when that first render happens
 * on a URL somebody pasted in.
 */
export function useRoute(): Route {
  return useSyncExternalStore(
    subscribe,
    () => routeFromHash(window.location.hash),
    () => 'editor' as Route,
  )
}
