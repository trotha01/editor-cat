/**
 * Whether an asset the library has not got might still be on its way.
 *
 * A clip holds an asset id, not the asset, so a clip whose asset is not in the
 * library is either waiting on it or pointing at nothing — and those look
 * exactly the same from the clip's side. What tells them apart is whether
 * anything is still arriving: the library's own first load, or a project's
 * media coming back from Drive, both leave a gap between the clips being there
 * and their assets being there.
 *
 * One hook because three places have to answer it the same way — the picture
 * track, the video lanes and the preview's readiness reporting. Two of them
 * saying "loading" while the third drew a red bar over the same clip is the bug
 * this exists to keep from coming back.
 */
import { useAssetStore } from '../state/useAssetStore'
import { useProjectsStore } from '../state/useProjectsStore'

export function useMediaLoading(): boolean {
  const assetsLoading = useAssetStore((state) => state.loading)
  const hydrating = useProjectsStore((state) => state.hydration !== null)
  return assetsLoading || hydrating
}
