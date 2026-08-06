/**
 * Which build this is.
 *
 * Exists because "the deployed site behaves like code I already fixed" is a
 * question you cannot answer by reading the repository. A branch deploy lags the
 * branch you were working on, a preview lags the PR, and a cached bundle lags
 * everything — and all three look identical from the outside.
 *
 * `__BUILD__` is substituted by Vite at build time (see vite.config.ts), so this
 * describes the bundle you are actually running rather than whatever the server
 * would say if asked now.
 */
export interface Build {
  /** Full commit SHA, or 'unknown' where neither Netlify nor git could say. */
  commit: string
  /** The first seven characters, for reading aloud. */
  short: string
  branch: string
  /** Netlify's deploy context: production, branch-deploy, deploy-preview, or local. */
  context: string
  builtAt: string
}

export const BUILD: Build = __BUILD__

/**
 * Puts the build on `window` so `VERSION` answers in the browser console.
 *
 * A global rather than a UI element on purpose: this is for whoever is debugging
 * a deployment, and it should be reachable without navigating anywhere — including
 * from a screen that is refusing to let anyone in.
 */
export function installVersionGlobal(): void {
  if (typeof window === 'undefined') return
  window.VERSION = BUILD
}
