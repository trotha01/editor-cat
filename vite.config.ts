/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * What is actually deployed, stamped in at build time.
 *
 * Netlify supplies these itself, and they are the ones that count: a branch
 * deploy building `staging` says so, which is the question you are usually
 * asking when the site behaves like code you have already fixed. Falling back to
 * git keeps `npm run build` locally honest. Anything unavailable ends up as
 * "unknown" rather than failing the build — this is a debugging aid, not a
 * dependency.
 */
function gitValue(command: string): string {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

function buildInfo() {
  const commit = process.env.COMMIT_REF || gitValue('git rev-parse HEAD')
  return {
    commit: commit || 'unknown',
    short: commit ? commit.slice(0, 7) : 'unknown',
    branch: process.env.BRANCH || gitValue('git rev-parse --abbrev-ref HEAD') || 'unknown',
    // 'production', 'branch-deploy', 'deploy-preview' — or 'local' off Netlify.
    context: process.env.CONTEXT || 'local',
    builtAt: new Date().toISOString(),
  }
}

/**
 * The address the staging site answers on, as a browser will see it.
 *
 * `DEPLOY_PRIME_URL` is the stable one — the branch's own URL, or the site's
 * primary URL where staging is a site of its own — as against `DEPLOY_URL`,
 * which is unique to each deploy and is never what anyone has in their address
 * bar. `STAGING_HOST` overrides both, for a site reached through a domain
 * Netlify has not been told about.
 *
 * Whatever this comes to is compared against `location.hostname` in the browser,
 * so it is a claim to be checked rather than a permission to draw. See
 * `badgeBuild` in src/lib/stagingBuild.ts.
 */
function stagingHost(): string {
  const value = process.env.STAGING_HOST || process.env.DEPLOY_PRIME_URL || process.env.URL
  if (!value) return ''
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    // Already a bare host, most likely, which is the other thing anyone setting
    // STAGING_HOST by hand would reasonably write.
    return value.trim().toLowerCase()
  }
}

/**
 * Which pull request the staging deploy is showing.
 *
 * Staging is one branch and one URL — fixed, because Google holds it — so every
 * deploy of it reports the same branch and a bot's merge commit, and `__BUILD__`
 * above can say nothing about the work that caused it. The workflow that
 * rebuilds the branch writes what it knows into it instead
 * (.github/workflows/staging.yml), and this reads it back at build time, the
 * same way everything else here is stamped in.
 *
 * No other branch carries that file, so every other build inlines `null` and has
 * nothing it could draw a badge from. That is the point of doing it this way
 * rather than with a flag: production is not excluded by remembering to exclude
 * it.
 */
function stagingBuild(): unknown {
  let raw: string
  try {
    raw = readFileSync(new URL('./staging-build.json', import.meta.url), 'utf8')
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const info = parsed as Record<string, unknown>
    // A file we cannot read is a file we do not draw from. Like `buildInfo`,
    // this is a debugging aid and has no business failing a build.
    if (typeof info.sha !== 'string' || typeof info.builtAt !== 'string') return null
    // The workflow knows the pull request and nothing about where any of it is
    // deployed; Netlify knows the address and nothing about the pull request.
    // The two halves only ever meet here.
    return { ...info, host: stagingHost() }
  } catch {
    return null
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD__: JSON.stringify(buildInfo()),
    __STAGING__: JSON.stringify(stagingBuild()),
  },
  server: {
    // `netlify dev` proxies the app and serves /api/* from netlify/functions.
    // When running plain `vite dev` the /api routes are unavailable, which is
    // why mock mode (VITE_MOCK_PROVIDERS=1) exists.
    port: 5173,
  },
  build: {
    // ffmpeg-core is ~30MB of wasm and is fetched at runtime from /ffmpeg/,
    // never bundled. Keep the JS chunks themselves small.
    chunkSizeWarningLimit: 800,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'netlify/**/*.test.ts'],
  },
})
