/**
 * Where Google sends the browser back to.
 *
 * Handled by the app itself: Netlify's SPA fallback serves index.html for this
 * path, and main.tsx peels it off before React mounts (see oauthCallback.ts).
 * Serving it from a function instead would need inline script to reach the
 * opener, which the site's Content-Security-Policy does not allow.
 *
 * Its own module because it is the one thing the browser and the functions have
 * to agree on — Google compares the URI the pop-up asked with against the one
 * the exchange presents, byte for byte — and they are separate TypeScript
 * projects. Reaching for it inside `oauthPopup.ts` would make the functions
 * project typecheck that file's build-time `import.meta.env`, which is a Vite
 * idea and means nothing where the functions run.
 */
export const CALLBACK_PATH = '/oauth/google'
