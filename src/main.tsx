import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Root } from './Root'
import { SignInGate } from './components/SignInGate'
import { installVersionGlobal } from './lib/version'
import './index.css'

function mount(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('Root element is missing from index.html.')

  createRoot(container).render(
    <StrictMode>
      {/* Wraps the pages rather than living inside them, so nothing mounts — and
          no project is fetched — until there is a session to fetch it for. */}
      <SignInGate>
        <Root />
      </SignInGate>
    </StrictMode>,
  )
}

// Before anything that can fail, and before the gate decides whether to let
// anyone in: whoever is debugging a deployment needs `VERSION` to answer even on
// a screen that is refusing them entry.
installVersionGlobal()

// Auth0 returns from Google to this same page, carrying `code` and `state` in
// the query string, and the auth store consumes them on mount — so unlike the
// pop-up flow this replaced, there is no second entry point here and no callback
// route to keep out of the editor. See src/lib/auth0/client.ts.
mount()
