import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { SignInGate } from './components/SignInGate'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root element is missing from index.html.')

createRoot(container).render(
  <StrictMode>
    {/* Wraps App rather than living inside it, so nothing in the editor mounts
        — and no project is fetched — until there is a session to fetch it for. */}
    <SignInGate>
      <App />
    </SignInGate>
  </StrictMode>,
)
