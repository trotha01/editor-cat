/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * What is actually deployed, stamped in at build time.
 *
 * Netlify supplies these itself, and they are the ones that count: a branch
 * deploy names the branch it built, which is the question you are usually
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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD__: JSON.stringify(buildInfo()),
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
