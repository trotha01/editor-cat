/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" to fake every provider call locally. See src/lib/mock.ts. */
  readonly VITE_MOCK_PROVIDERS?: string
  /**
   * Google OAuth client ID (a Web application client). Leave unset to build
   * without sign-in or Drive at all.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string
  /**
   * Google API key, for the Google Picker. Public by design and restricted by
   * HTTP referrer in the Cloud console, exactly as the client ID is restricted
   * by origin.
   */
  readonly VITE_GOOGLE_API_KEY?: string
  /**
   * The Cloud project number, which the Picker passes as its app id so that
   * files chosen through it stay reachable under `drive.file` afterwards.
   */
  readonly VITE_GOOGLE_PROJECT_NUMBER?: string
  /**
   * Supabase project URL and anon key. Both must be set for projects to be
   * saved to the cloud; leave them unset to run purely against IndexedDB.
   * The anon key is public — row-level security is what protects the data.
   */
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Substituted by Vite at build time. See `define` in vite.config.ts. */
declare const __BUILD__: import('./lib/version').Build

/**
 * The pull request this staging deploy is showing, substituted at build time
 * alongside `__BUILD__` — and `null` in every build that is not a staging one,
 * which is most of them. See src/lib/stagingBuild.ts.
 */
declare const __STAGING__: import('./lib/stagingBuild').StagingBuild | null

interface Window {
  /**
   * The deployed build, so `VERSION` in the browser console answers "which
   * commit is this?" without leaving the page. See src/lib/version.ts.
   */
  VERSION: import('./lib/version').Build
}
