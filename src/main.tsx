import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { SignInGate } from './components/SignInGate'
import { StagingBadge } from './components/StagingBadge'
import { completeOauthCallback, isOauthCallback } from './lib/google/oauthCallback'
import { relocateToDeployDomain } from './lib/netlify/deployHost'
import { installVersionGlobal } from './lib/version'
import './index.css'

function mount(): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('Root element is missing from index.html.')

  createRoot(container).render(
    <StrictMode>
      {/* Wraps App rather than living inside it, so nothing in the editor mounts
          — and no project is fetched — until there is a session to fetch it for. */}
      <SignInGate>
        <App />
      </SignInGate>

      {/* Outside the gate for the reason `VERSION` is installed before it: which
          build this is has to be answerable from the screen that is refusing you
          entry, which on staging is a screen you see often. Draws nothing at all
          off the staging site — see src/lib/stagingBuild.ts. */}
      <StagingBadge />
    </StrictMode>,
  )
}

// Before everything, including `VERSION`: this document may not be on the host
// it is supposed to be on — Netlify Identity returns from Google to a deploy's
// netlify.app address whichever one the visitor started from — and every line
// below reads the address it landed on. Nothing else should run in a page that
// is already leaving. See ./lib/netlify/deployHost.ts.
if (!relocateToDeployDomain()) {
  // Before anything that can fail, and before the gate decides whether to let
  // anyone in: whoever is debugging a deployment needs `VERSION` to answer even
  // on a screen that is refusing them entry.
  installVersionGlobal()

  // Google's consent pop-up lands back on the registered callback origin, and
  // the SPA fallback serves it as this app. That window exists for a few
  // milliseconds, so it hands the authorisation code to whoever opened it and
  // closes; mounting the editor there would load a second copy of everything and
  // flash the sign-in gate inside the pop-up on the way past.
  if (isOauthCallback()) completeOauthCallback()
  else mount()
}
