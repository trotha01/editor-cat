/**
 * Putting a word's takes back in touch with their video files.
 *
 * A different repair from the one in `migrate.ts`, and the difference is what
 * makes it necessary. That one moves an asset whose row says it is in Drive.
 * This one is for takes whose asset row was **never written at all**.
 *
 * Two paths built the word shelf, and only one of them recorded assets
 * reliably. A video uploaded through the editor went through `ingestBlob`,
 * which catalogues it and awaits the result. A video discovered by walking the
 * Drive folder tree was catalogued with a fire-and-forget `void recordAsset(…)`
 * that nobody waited on and nothing retried. When those calls did not land, the
 * take kept its place in the shelf — its order, its label, its transcript — and
 * lost the only thing that could find its bytes.
 *
 * While Drive was still the fallback the damage was invisible: the take played
 * from Drive, and nobody had reason to notice the missing row. Removing Drive
 * is what surfaced it, all at once, as whole words reading "not on this
 * machine".
 *
 * The tree itself is what makes the repair possible. A folder per tier, a
 * folder per language inside it, a folder per word inside that, and the word's
 * videos in the word folder — so a take with no row can still be found by name,
 * walking down from the root that `drive_folders` remembers. That row and this
 * module are the two things `0011_drop_drive.sql` must wait for.
 *
 * **Pairing is the one judgement here, and it is deliberately timid.** A word's
 * takes are matched to its folder's files by position — the old sidecar's order
 * when one is still there, the folder's own name order otherwise. When the
 * counts do not agree the word is left completely alone and reported, because
 * the failure mode of guessing is silent and wrong: the right number of videos,
 * each under the wrong take, and no way to tell without watching all of them.
 */
import { getShelf } from '../supabase/shelf'
import { getDriveFolder } from '../supabase/driveFolder'
import { getAssets } from '../supabase/assets'
import { downloadFile, isFolder, kindForMime, listChildren, type DriveChild } from '../google/drive'
import { parseShelfDoc, parseSidecar, SIDECAR_NAME, type Word, type WordVideo } from '../words'
import { putBlob } from '../db'
import { newId, probeMedia } from '../media'
import { toDisplayMessage } from '../errors'
import { uploadFiles } from './upload'
import { recordKey } from './migrate'
import type { Asset } from '../types'

/** A word whose takes cannot be played, and where its files should be. */
export interface UnreachableWord {
  wordId: string
  /** As it reads on screen, which is also the folder's name in Drive. */
  text: string
  tier: string
  language: string
  /** Only the takes with no asset behind them; a word can be partly broken. */
  takes: WordVideo[]
}

export interface WordOutcome {
  word: string
  recovered: number
  /** Why nothing was done, when nothing was. */
  skipped?: string
}

export interface RecoveryProgress {
  done: number
  total: number
  current?: string
}

export interface RecoverySummary {
  recovered: number
  words: WordOutcome[]
}

/**
 * Every take in the shelf with no asset row behind it, grouped by word.
 *
 * Asked of the account rather than of this browser, and in one query rather
 * than per word: the shelf is the list of takes, the `assets` table is what
 * says which of them can be found, and the difference is the work.
 */
export async function unreachableWords(): Promise<UnreachableWord[]> {
  const stored = await getShelf()
  if (!stored) return []

  const shelf = parseShelfDoc(stored.doc)
  const tiers = new Map(shelf.tiers.map((tier) => [tier.id, tier.name]))
  const languages = new Map(shelf.languages.map((entry) => [entry.id, entry]))

  const ids = [...new Set(shelf.words.flatMap((word) => word.videos.map((v) => v.assetId)))]
  if (ids.length === 0) return []

  const known = new Set((await getAssets(ids)).map((row) => row.id))

  const broken: UnreachableWord[] = []
  for (const word of shelf.words) {
    const takes = word.videos.filter((video) => !known.has(video.assetId))
    if (takes.length === 0) continue

    const language = languages.get(word.languageId)
    // A word whose language or tier is missing has no folder path to walk, so
    // it is left out rather than reported as recoverable.
    if (!language) continue
    const tier = tiers.get(language.tierId)
    if (!tier) continue

    broken.push({ wordId: word.id, text: word.text, tier, language: language.name, takes })
  }
  return broken
}

/** Matches the names people typed against the names Drive holds. */
function sameName(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'accent' }) === 0
}

function folderNamed(children: readonly DriveChild[], name: string): DriveChild | undefined {
  return children.find((child) => isFolder(child) && sameName(child.name, name))
}

/**
 * The files of a word's folder, in the order its takes were meant to play.
 *
 * The sidecar first, because it is what the person actually arranged: it lists
 * Drive file ids in play order, and the folder listing is only ever alphabetical.
 * Anything the sidecar names that is no longer in the folder is dropped, and
 * anything in the folder the sidecar does not name is appended — so a sidecar
 * that has drifted degrades to "mostly right" instead of losing takes.
 */
export function orderedFiles(
  files: readonly DriveChild[],
  sidecarIds: readonly string[],
): DriveChild[] {
  if (sidecarIds.length === 0) return [...files]

  const byId = new Map(files.map((file) => [file.id, file]))
  const ordered: DriveChild[] = []
  for (const id of sidecarIds) {
    const file = byId.get(id)
    if (file) {
      ordered.push(file)
      byId.delete(id)
    }
  }
  return [...ordered, ...byId.values()]
}

async function wordFolderFiles(
  rootId: string,
  word: UnreachableWord,
  signal?: AbortSignal,
): Promise<{ files: DriveChild[] } | { skipped: string }> {
  const tierFolder = folderNamed(await listChildren(rootId, signal), word.tier)
  if (!tierFolder) return { skipped: `No folder named “${word.tier}” in Drive.` }

  const languageFolder = folderNamed(await listChildren(tierFolder.id, signal), word.language)
  if (!languageFolder) return { skipped: `No folder named “${word.language}” under ${word.tier}.` }

  const wordFolder = folderNamed(await listChildren(languageFolder.id, signal), word.text)
  if (!wordFolder) return { skipped: `No folder named “${word.text}” under ${word.language}.` }

  const children = await listChildren(wordFolder.id, signal)
  const videos = children.filter(
    (child) => !isFolder(child) && kindForMime(child.mimeType) === 'video',
  )

  const sidecarFile = children.find((child) => child.name === SIDECAR_NAME)
  let sidecarIds: string[] = []
  if (sidecarFile) {
    try {
      const sidecar = parseSidecar(await (await downloadFile(sidecarFile.id, signal)).text())
      sidecarIds = sidecar?.videos.map((entry) => entry.driveFileId) ?? []
    } catch {
      // A sidecar that will not come down costs the order, not the videos.
    }
  }

  return { files: orderedFiles(videos, sidecarIds) }
}

/**
 * Whether a word's takes and its folder's files can be paired at all.
 *
 * Only when there are exactly as many files as takes. Anything else is a guess,
 * and the wrong guess is not visible: every take would have a video, each of
 * them the wrong one, and finding out means watching all of them.
 */
export function pairingProblem(takes: number, files: number): string | null {
  if (files === 0) return 'Its Drive folder has no videos in it.'
  if (files === takes) return null
  return `Its Drive folder has ${files} video${files === 1 ? '' : 's'} for ${takes} take${
    takes === 1 ? '' : 's'
  }, so which is which cannot be worked out. Left alone.`
}

export interface RecoverOptions {
  onProgress?: (progress: RecoveryProgress) => void
  signal?: AbortSignal
  /** Called for each repaired take, so the shelf can be rewritten as it goes. */
  onRepaired: (wordId: string, videoId: string, assetId: string) => void
}

/**
 * Pulls every unreachable take's file out of Drive and into R2.
 *
 * One take at a time, and each one finished — uploaded, catalogued, and its
 * take repointed — before the next begins. The same reasoning as the migration:
 * there is no batch to half-commit, so a closed tab loses at most the file in
 * flight, and a second run has less to do rather than the same amount.
 */
export async function recoverShelf(options: RecoverOptions): Promise<RecoverySummary> {
  const { onProgress, signal, onRepaired } = options

  const root = await getDriveFolder()
  if (!root) {
    throw new Error(
      'This account has no record of the Drive folder its videos are in, so there is nowhere to look.',
    )
  }

  const words = await unreachableWords()
  const total = words.reduce((sum, word) => sum + word.takes.length, 0)
  const outcomes: WordOutcome[] = []
  let done = 0
  let recovered = 0

  const report = (current?: string) =>
    onProgress?.({ done, total, ...(current ? { current } : {}) })
  report()

  for (const word of words) {
    if (signal?.aborted) break
    report(word.text)

    let files: DriveChild[]
    try {
      const found = await wordFolderFiles(root.id, word, signal)
      if ('skipped' in found) {
        outcomes.push({ word: word.text, recovered: 0, skipped: found.skipped })
        done += word.takes.length
        report()
        continue
      }
      files = found.files
    } catch (cause) {
      outcomes.push({ word: word.text, recovered: 0, skipped: toDisplayMessage(cause) })
      done += word.takes.length
      report()
      continue
    }

    // Counted against *every* take of the word, not just the broken ones: the
    // folder holds all of them, so pairing by position only lines up when the
    // word is broken from end to end. A partly-broken word is left alone.
    const problem = pairingProblem(word.takes.length, files.length)
    if (problem) {
      outcomes.push({ word: word.text, recovered: 0, skipped: problem })
      done += word.takes.length
      report()
      continue
    }

    let repaired = 0
    for (const [index, take] of word.takes.entries()) {
      if (signal?.aborted) break
      const file = files[index]
      if (!file) break
      report(`${word.text} · ${index + 1}/${files.length}`)

      try {
        const blob = await downloadFile(file.id, signal)
        const asset: Asset = {
          id: newId('asset'),
          kind: 'video',
          blobKey: newId('blob'),
          mimeType: blob.type || 'video/mp4',
          name: file.name,
          createdAt: Date.now(),
          ...(await probeMedia(blob, 'video').catch(() => ({}))),
        }

        // Kept locally as well: this browser has just spent the bandwidth, and
        // a take that plays straight after the repair is the point of it.
        await putBlob(asset.blobKey, blob)

        const result = await uploadFiles({
          scope: 'asset',
          files: [{ name: asset.id, blob, contentType: asset.mimeType }],
          ...(signal ? { signal } : {}),
        })
        const key = result.objects[0]?.key
        if (!key) throw new Error('The upload did not report where it went.')

        await recordKey(asset, key, blob.size)
        // Last, and only once the bytes are somewhere durable. A take repointed
        // at an asset whose upload failed would look repaired and play nothing.
        onRepaired(word.wordId, take.id, asset.id)
        repaired += 1
        recovered += 1
      } catch (cause) {
        outcomes.push({ word: word.text, recovered: repaired, skipped: toDisplayMessage(cause) })
        break
      } finally {
        done += 1
        report()
      }
    }

    if (repaired > 0 && !outcomes.some((entry) => entry.word === word.text)) {
      outcomes.push({ word: word.text, recovered: repaired })
    }
  }

  return { recovered, words: outcomes }
}

/** Re-exported so the panel can name a word without importing the model. */
export type { Word }
