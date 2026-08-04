/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to "1" to fake every provider call locally. See src/lib/mock.ts. */
  readonly VITE_MOCK_PROVIDERS?: string
  /**
   * Google OAuth client ID (a Web application client). Leave unset to build
   * without the Drive integration; the Settings panel then explains it is off.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
