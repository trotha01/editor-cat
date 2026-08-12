/**
 * Asking, once, whether this account is one this deployment is for.
 *
 * The site's fal and ElevenLabs accounts pay for everything the editor does, so
 * a deployment says who it is for with `ALLOWED_EMAILS` and every function
 * enforces it. This is the same question asked at the door, so somebody who is
 * not on the list is told so on the sign-in screen rather than four screens in,
 * by whichever button they happened to press first.
 *
 * A failure that is not a refusal is treated as a pass. The server is the thing
 * that actually enforces this — every endpoint checks independently — so a
 * network blip here can safely open a door that every room behind it is still
 * locked against. The alternative is locking the right people out of the editor
 * because one status request did not arrive.
 */
import { auth0Token } from './auth0/client'
import { isMockEnabled } from './mock'

export interface AccessCheck {
  allowed: boolean
  /** Why not, in words meant for the person reading them. Null when allowed. */
  reason: string | null
}

const ALLOWED: AccessCheck = { allowed: true, reason: null }

export async function checkAccess(): Promise<AccessCheck> {
  // Nothing to check and nothing to spend: mock mode has no functions behind it.
  if (isMockEnabled()) return ALLOWED

  try {
    const token = await auth0Token()
    // No session yet is not a refusal — it is the state before one.
    if (!token) return ALLOWED

    const response = await fetch('/api/access', { headers: { authorization: `Bearer ${token}` } })
    if (response.ok) return ALLOWED
    if (response.status !== 403) return ALLOWED

    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: string }
    return { allowed: false, reason: body.detail || body.error || null }
  } catch {
    return ALLOWED
  }
}
