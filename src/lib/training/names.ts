/**
 * Turning a camera roll into names R2 will take.
 *
 * The endpoint refuses anything that is not a bare, boring filename — see
 * netlify/lib/r2Keys.ts, where `SAFE_NAME` is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
 * — and a real folder of photos is full of names that are not: `IMG_0142 (1).HEIC`,
 * `Grandma's café.jpg`, `写真.png`. Sending those and reporting four hundred
 * refusals would be a page that works only for files somebody already renamed
 * by hand, which is not a page anybody wants.
 *
 * **Derived from the original name, never from a counter.** Numbering the files
 * `0001.jpg`, `0002.jpg` would be tidier to look at and would quietly break the
 * thing this page needs most: picking the same folder again after an
 * interrupted upload has to produce the same names, or the set cannot tell what
 * already arrived and can only offer to send everything a second time. A pure
 * function of the filename gives that for free. The index is a fallback for the
 * one case it cannot cover — a name with nothing left after sanitising.
 */

/** The server's cap, and the reason for every truncation below. */
export const MAX_NAME_LENGTH = 64

/** Mirrors `TRAINING_CONTENT_TYPES` in netlify/lib/r2Keys.ts. */
export const TRAINING_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const

export type TrainingContentType = (typeof TRAINING_CONTENT_TYPES)[number]

/**
 * What a file with a given extension is.
 *
 * Needed because `File.type` is not reliably filled in: browsers derive it from
 * the extension against a table of their own, and HEIC — most of a modern
 * iPhone's camera roll — is missing from that table often enough that a set of
 * photos arrives with empty types. Guessing from the extension is what the
 * browser was going to do anyway; doing it here means those photos upload
 * instead of being reported as "files of no known kind".
 */
const BY_EXTENSION: Record<string, TrainingContentType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
}

/** The extension we write for a type whose file arrived without a usable one. */
const BY_TYPE: Record<TrainingContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

function isTrainingType(value: string): value is TrainingContentType {
  return (TRAINING_CONTENT_TYPES as readonly string[]).includes(value)
}

/**
 * What this file is, or null if it is not something a training set holds.
 *
 * The browser's answer is preferred and the extension is the fallback, in that
 * order: `File.type` is read from the bytes' registered type on every platform
 * that fills it in at all, and an extension is only ever a claim about them.
 */
export function contentTypeOf(file: { name: string; type: string }): TrainingContentType | null {
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? ''
  if (isTrainingType(declared)) return declared

  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1]?.toLowerCase()
  return (extension && BY_EXTENSION[extension]) || null
}

function splitExtension(name: string): { stem: string; extension: string | null } {
  const match = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(name)
  if (!match) return { stem: name, extension: null }
  return { stem: match[1] as string, extension: (match[2] as string).toLowerCase() }
}

/**
 * The safe part of a filename.
 *
 * Accents are decomposed and their marks dropped rather than replaced with
 * dashes, so `café` becomes `cafe` and not `caf-`. Scripts with no ASCII form at
 * all — the `写真.png` case — legitimately end up empty, which is what the
 * fallback name is for.
 */
function sanitiseStem(stem: string): string {
  return (
    stem
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      // The leading character must be alphanumeric: that is what rules out `.`
      // and `..`, which are names R2 would store and a URL would walk out of.
      .replace(/^[^a-z0-9]+/, '')
      .replace(/[-._]+$/, '')
  )
}

/**
 * The name one file will be stored under, ignoring what else is in the set.
 *
 * `index` is only reached by a name that sanitises to nothing, and it is the
 * file's position in the picked list — so it is stable for a given selection
 * and not for two different ones. A folder of files named only in Japanese is
 * the case where re-picking will not line up with what is already uploaded;
 * everything with an ASCII stem is exact.
 */
export function storageName(
  file: { name: string; type: string },
  index: number,
  contentType: TrainingContentType,
): string {
  const { stem, extension } = splitExtension(file.name)
  const suffix = extension && /^[a-z0-9]+$/.test(extension) ? extension : BY_TYPE[contentType]

  const safe = sanitiseStem(stem)
  const base = safe.length > 0 ? safe : `photo-${String(index + 1).padStart(4, '0')}`

  // The extension is kept whole and the stem loses characters instead: two
  // photos out of four hundred sharing a truncated stem is a numbered
  // collision, while a truncated extension is a file nothing can open.
  const room = MAX_NAME_LENGTH - suffix.length - 1
  return `${base.slice(0, room).replace(/[-._]+$/, '') || 'photo'}.${suffix}`
}

/**
 * Adds a number to a name already taken, keeping inside the cap.
 *
 * `photo.jpg` -> `photo-2.jpg` -> `photo-3.jpg`. Two files whose names differ
 * only in something this module strips — `a b.jpg` and `a-b.jpg` — are the case
 * this exists for, and it is rare enough that the number can simply count up.
 */
export function numberedName(name: string, attempt: number): string {
  const { stem, extension } = splitExtension(name)
  const marker = `-${attempt}`
  const suffix = extension ? `.${extension}` : ''
  const room = MAX_NAME_LENGTH - marker.length - suffix.length
  return `${stem.slice(0, room).replace(/[-._]+$/, '') || 'photo'}${marker}${suffix}`
}

/**
 * A set name the endpoint will store under.
 *
 * Stricter than a filename: a set name becomes a whole path segment, so it is
 * checked against `isSafeId` there — letters, numbers, dashes and underscores,
 * and no dots at all. Typed by hand rather than generated, because it is what
 * the folder in the bucket is called and somebody will be looking for it there.
 */
export function toSetId(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 64)
}

/** Mirrors `isSafeId` in netlify/lib/r2Keys.ts. */
export function isSetId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export interface NamedFile<T> {
  file: T
  name: string
  contentType: TrainingContentType
}

export interface NamingResult<T> {
  named: NamedFile<T>[]
  /** Files that are not a kind this bucket takes, with what they looked like. */
  rejected: { file: T; reason: string }[]
}

/**
 * Names a whole selection at once, so nothing in it collides.
 *
 * Only files in this same selection are numbered apart. A name that is already
 * in the bucket is deliberately left alone: that is the same photo being
 * offered again, and the uploader skips it rather than storing a second copy
 * under `-2` — which is the whole of how an interrupted upload resumes.
 */
export function nameSelection<T extends { name: string; type: string }>(
  files: T[],
): NamingResult<T> {
  const named: NamedFile<T>[] = []
  const rejected: { file: T; reason: string }[] = []
  const used = new Set<string>()

  files.forEach((file, index) => {
    const contentType = contentTypeOf(file)
    if (!contentType) {
      rejected.push({ file, reason: 'not a photo or video this set stores' })
      return
    }

    let name = storageName(file, index, contentType)
    for (let attempt = 2; used.has(name); attempt += 1) {
      name = numberedName(storageName(file, index, contentType), attempt)
    }

    used.add(name)
    named.push({ file, name, contentType })
  })

  return { named, rejected }
}
