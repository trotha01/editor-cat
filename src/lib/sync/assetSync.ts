/**
 * Keeping the asset catalogue on the server in step with this browser.
 *
 * Two moments matter: when an asset first appears, and again once its Drive
 * upload finishes and it finally has a durable location. The first write makes
 * the timeline reconstructable; the second makes the bytes recoverable.
 */
import { upsertAsset } from '../supabase/assets'
import { isSupabaseConfigured } from '../supabase/client'
import { useAuthStore } from '../../state/useAuthStore'
import type { Asset } from '../types'

/** Whether there is an account to record against right now. */
function canRecord(): boolean {
  return isSupabaseConfigured() && useAuthStore.getState().session !== null
}

/**
 * Records an asset's metadata, ignoring failures.
 *
 * Best-effort by design: the asset is already saved locally and, if Drive is
 * connected, on its way there. A catalogue write that fails costs
 * cross-device visibility, which is not worth interrupting an edit over.
 */
export async function recordAsset(asset: Asset, byteSize?: number): Promise<void> {
  if (!canRecord()) return
  try {
    await upsertAsset(asset, byteSize)
  } catch {
    // Deliberately swallowed — see above.
  }
}
