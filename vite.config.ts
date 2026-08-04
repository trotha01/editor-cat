/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
