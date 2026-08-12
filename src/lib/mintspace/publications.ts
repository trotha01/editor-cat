/**
 * What this project has already put in the Mintspace feed.
 *
 * Pure functions over the project document, with no client behind them, so the
 * question "is this already up?" can be asked before anything is signed in to —
 * and answered on a machine that has never signed in at all, since the record
 * travels with the project rather than with the browser.
 */
import { sha256Hex } from '../digest'
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

/**
 * JSON with object keys in a fixed order.
 *
 * A project that has been to Supabase and back is not key-for-key the object
 * that went: it is stored as `jsonb`, which keeps no order of its own. So
 * `JSON.stringify` of one project can differ between the machine that saved it
 * and the machine that loaded it, and a fingerprint built on that would read as
 * a different video purely for having synced. Arrays are left alone — their
 * order is significant everywhere in a timeline.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/** The settings, beyond the timeline itself, that change what comes out. */
export interface ExportSettings {
  crf: number
}

/**
 * A fingerprint of everything that decides what this export will be.
 *
 * The timeline plus the quality setting — the frame size is part of the
 * timeline already. Deliberately not the project's id or name: renaming a
 * project does not make its export a different video. Deliberately not its
 * publications either, and that one is load-bearing rather than tidy: they
 * change the moment something is published, so including them would make every
 * export unrecognisable straight after the publish that should be recognised.
 *
 * Null when the browser will not hash, which `publishedFrom` reads as "cannot
 * say" rather than "no" — see lib/digest.ts.
 */
export async function sourceKeyOf(
  project: Project,
  settings: ExportSettings,
): Promise<string | null> {
  const { id: _id, name: _name, publications: _publications, ...doc } = project
  return sha256Hex(new Blob([stableStringify({ doc, crf: settings.crf })]))
}

/**
 * The post this project, at these settings, already went up as.
 *
 * A prediction rather than a proof — it says the export would be made from the
 * same things, not that the bytes will match — which is why it is what the
 * dialog *shows* and `publishedAs` is what the publish path *checks*.
 */
export function publishedFrom(project: Project, sourceKey: string | null): Publication | undefined {
  if (!sourceKey) return undefined
  return publicationsOf(project).find((entry) => entry.sourceKey === sourceKey)
}
