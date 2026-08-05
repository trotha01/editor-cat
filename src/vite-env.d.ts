/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" to fake every provider call locally. See src/lib/mock.ts. */
  readonly VITE_MOCK_PROVIDERS?: string
  /**
   * Google OAuth client ID (a Web application client). Leave unset to build
   * without the Drive integration; the Settings panel then explains it is off.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string
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
