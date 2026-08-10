/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The Auth0 tenant this site signs in against, the SPA application's client
   * id, and the API identifier its access tokens are minted for. All three are
   * required for sign-in — and therefore for Drive, which rides on the same
   * login. None is a secret: the domain is in every authorisation URL, the
   * client id is public by design, and the audience is in every token.
   */
  readonly VITE_AUTH0_DOMAIN?: string
  readonly VITE_AUTH0_CLIENT_ID?: string
  readonly VITE_AUTH0_AUDIENCE?: string
  /** Set to "1" to fake every provider call locally. See src/lib/mock.ts. */
  readonly VITE_MOCK_PROVIDERS?: string
  /**
   * Google API key, for the Google Picker. Public by design, and restricted by
   * HTTP referrer in the Cloud console — which is the one Google allowlist this
   * app still keeps, since the Picker calls Google straight from the page.
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
