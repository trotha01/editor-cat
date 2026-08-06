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
