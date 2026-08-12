/**
 * The library: which files belong to a project.
 *
 * The catalogue itself is per browser — one IndexedDB store holds every asset
 * this machine has ever ingested, and timelines point into it — so "in this
 * project's library" is a fact about the project, and it is kept on the project
 * document, where it travels with the edit to every other machine.
 *
 * Membership deliberately outlives the edit. A shot taken off the timeline is
 * still a file that was made for this project and is usually on its way back
 * on; the only thing that takes a file out of the library is being deleted from
 * it. The timeline gives the lower bound rather than the answer: everything the
 * edit uses is in the library whether or not it was ever listed there, which is
 * how a project saved before this list existed is read.
 */
import { videoClipsOf } from './videoTracks'
import type { Asset, Project } from './types'

/** Every asset id the edit itself uses: picture, layers and audio. */
export function referencedAssetIds(project: Project): string[] {
  const ids = new Set<string>()
  for (const clip of project.clips) ids.add(clip.assetId)
  for (const clip of videoClipsOf(project)) ids.add(clip.assetId)
  for (const clip of project.audioClips) {
    ids.add(clip.assetId)
    // The converted take is a separate asset and is what plays when the clip is
    // set to use it, so a project restored without it is missing audio.
    if (clip.convertedAssetId) ids.add(clip.convertedAssetId)
  }
  return [...ids]
}

/**
 * What the library holds.
 *
 * A project saved before the list existed is read as the files its edit uses,
 * which is the most that can honestly be said about it — the rest of what was
 * on screen belonged to every other project as much as to this one. Opening it
 * writes that down (see `withBackfilledLibrary`), which is what makes the list
 * something a file can be taken out of.
 */
export function libraryAssetIdsOf(project: Project): string[] {
  return project.libraryAssetIds ?? referencedAssetIds(project)
}

/** Writes down what an absent list was being read as. */
export function withBackfilledLibrary(project: Project): Project {
  if (project.libraryAssetIds) return project
  return { ...project, libraryAssetIds: referencedAssetIds(project) }
}

/** Puts a file in the library, or hands the project back if it is already in. */
export function withLibraryAsset(project: Project, assetId: string): Project {
  const ids = libraryAssetIdsOf(project)
  if (ids.includes(assetId)) return project
  return { ...project, libraryAssetIds: [...ids, assetId] }
}

/** Takes a file out of the library. */
export function withoutLibraryAsset(project: Project, assetId: string): Project {
  const ids = libraryAssetIdsOf(project)
  if (!ids.includes(assetId)) return project
  return { ...project, libraryAssetIds: ids.filter((id) => id !== assetId) }
}

/**
 * The library's own assets, in the order the catalogue holds them — newest
 * first, which is the order the panel wants.
 *
 * An id with no asset behind it is skipped rather than drawn as a blank row:
 * metadata for a file this browser has never seen arrives with hydration, and
 * until it does there is nothing to show.
 */
export function libraryAssets(assets: readonly Asset[], project: Project): Asset[] {
  const ids = new Set(libraryAssetIdsOf(project))
  return assets.filter((asset) => ids.has(asset.id))
}

/**
 * Whether nothing on this machine wants a file's bytes any more.
 *
 * Deleting one from a library is about that library, and the same asset can sit
 * in more than one: importing a Drive file that is already here adopts the copy
 * rather than fetching a second one. So the bytes only go when no project left
 * on this machine lists the file or uses it.
 *
 * Judged against the local project cache, which is not necessarily every
 * project the account has. That is the right way round: a project that has
 * never been opened here has no local bytes to lose either, and hydration
 * fetches them back from Drive when it is.
 */
export function isAssetOrphaned(assetId: string, projects: readonly Project[]): boolean {
  return !projects.some(
    (project) =>
      libraryAssetIdsOf(project).includes(assetId) || referencedAssetIds(project).includes(assetId),
  )
}
