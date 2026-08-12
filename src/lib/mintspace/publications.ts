/**
 * What this project has already put in the Mintspace feed.
 *
 * Pure functions over the project document, with no client behind them, so the
 * question "is this already up?" can be asked before anything is signed in to —
 * and answered on a machine that has never signed in at all, since the record
 * travels with the project rather than with the browser.
 */
import type { Project, Publication } from '../types'

/** Absent means none: every project saved before publishing existed has none. */
export function publicationsOf(project: Project): Publication[] {
  return project.publications ?? []
}

/**
 * The post this exact file was already published as, if it was.
 *
 * Matched on the content hash rather than on the project, because a project is
 * a thing that changes: re-exporting after an edit is a new video and should
 * go up as one, while re-exporting after no edit at all is the same video and
 * is the case worth catching.
 *
 * A null digest — a browser that would not hash, see lib/digest.ts — matches
 * nothing rather than everything. The alternative is refusing to publish over
 * a comparison that could not be made, which would make an unhashable browser
 * unable to post at all.
 */
export function publishedAs(project: Project, digest: string | null): Publication | undefined {
  if (!digest) return undefined
  return publicationsOf(project).find((entry) => entry.digest === digest)
}
