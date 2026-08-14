import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Putting a word's takes back in touch with their files.
 *
 * The dangerous part of this is not failing — it is succeeding wrongly. Pairing
 * takes to files by position is a guess dressed as an answer, and the wrong
 * guess produces a word where every take has a video and each one is the wrong
 * video. Nothing errors, nothing looks broken, and finding out means watching
 * all of them. So the rules about *when not to pair* are held down here at
 * least as firmly as the recovery itself.
 */
const getShelf = vi.fn()
const getAssets = vi.fn()
const getDriveFolder = vi.fn()
const listChildren = vi.fn()
const downloadFile = vi.fn()
const uploadFiles = vi.fn()
const recordKey = vi.fn()
const putBlob = vi.fn()

vi.mock('../supabase/shelf', () => ({ getShelf: () => getShelf() as unknown }))
vi.mock('../supabase/driveFolder', () => ({ getDriveFolder: () => getDriveFolder() as unknown }))
vi.mock('../supabase/assets', () => ({ getAssets: (ids: string[]) => getAssets(ids) as unknown }))

vi.mock('../google/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../google/drive')>()),
  listChildren: (parentId: string) => listChildren(parentId) as unknown,
  downloadFile: (id: string) => downloadFile(id) as unknown,
}))

vi.mock('./upload', () => ({ uploadFiles: (request: unknown) => uploadFiles(request) as unknown }))
vi.mock('./migrate', () => ({
  recordKey: (asset: unknown, key: string, size?: number) => recordKey(asset, key, size) as unknown,
}))
vi.mock('../db', () => ({ putBlob: (key: string, blob: Blob) => putBlob(key, blob) as unknown }))
vi.mock('../media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media')>()),
  // jsdom will not decode a video, so the probe would hang forever.
  probeMedia: () => Promise.resolve({ duration: 2 }),
}))

const { orderedFiles, pairingProblem, recoverShelf, unreachableWords } =
  await import('./recoverShelf')

const FOLDER = 'application/vnd.google-apps.folder'

function folder(id: string, name: string) {
  return { id, name, mimeType: FOLDER }
}

function video(id: string, name: string) {
  return { id, name, mimeType: 'video/mp4' }
}

/** One tier, one language, one word with three takes and no assets behind them. */
const SHELF = {
  tiers: [{ id: 'tier_1', name: 'Classical', createdAt: 0 }],
  languages: [{ id: 'lang_la', tierId: 'tier_1', name: 'Latin', createdAt: 0 }],
  words: [
    {
      id: 'w1',
      languageId: 'lang_la',
      text: 'Caelestis - Heavenly',
      createdAt: 0,
      videos: [
        { id: 'wv1', assetId: 'asset_1', role: 'intro' },
        { id: 'wv2', assetId: 'asset_2', role: 'word' },
        { id: 'wv3', assetId: 'asset_3', role: 'word' },
      ],
    },
  ],
}

/** The Drive tree as the walk sees it, keyed by the folder being listed. */
function tree(wordFiles: { id: string; name: string; mimeType: string }[]) {
  return (parentId: string) => {
    if (parentId === 'root') return Promise.resolve([folder('f_tier', 'Classical')])
    if (parentId === 'f_tier') return Promise.resolve([folder('f_lang', 'Latin')])
    if (parentId === 'f_lang') return Promise.resolve([folder('f_word', 'Caelestis - Heavenly')])
    if (parentId === 'f_word') return Promise.resolve(wordFiles)
    return Promise.resolve([])
  }
}

const onRepaired = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  getShelf.mockResolvedValue({ doc: SHELF, version: 1 })
  getAssets.mockResolvedValue([])
  getDriveFolder.mockResolvedValue({ id: 'root', name: 'Language Vids' })
  listChildren.mockImplementation(
    tree([video('d1', 'a.mp4'), video('d2', 'b.mp4'), video('d3', 'c.mp4')]),
  )
  downloadFile.mockResolvedValue(new Blob(['bytes'], { type: 'video/mp4' }))
  putBlob.mockResolvedValue(undefined)
  recordKey.mockResolvedValue(undefined)
  uploadFiles.mockImplementation((request: { files: { name: string }[] }) =>
    Promise.resolve({
      prefix: 'asset/hash/',
      objects: request.files.map((file) => ({ name: file.name, key: `asset/hash/${file.name}` })),
    }),
  )
})

describe('finding what cannot be played', () => {
  it('reports a take whose asset the account has never heard of', async () => {
    const found = await unreachableWords()

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      text: 'Caelestis - Heavenly',
      tier: 'Classical',
      language: 'Latin',
    })
    expect(found[0]?.takes).toHaveLength(3)
  })

  it('leaves alone a take whose asset row exists', async () => {
    // Whatever is wrong with that one, it is not this. An asset with a row but
    // no key is the *migration's* job, and doing both here would move the same
    // file twice.
    getAssets.mockResolvedValue([{ id: 'asset_2' }])

    const found = await unreachableWords()

    expect(found[0]?.takes.map((take) => take.id)).toEqual(['wv1', 'wv3'])
  })

  it('says nothing at all when every take can be reached', async () => {
    getAssets.mockResolvedValue([{ id: 'asset_1' }, { id: 'asset_2' }, { id: 'asset_3' }])

    await expect(unreachableWords()).resolves.toEqual([])
  })
})

describe('the order takes are paired in', () => {
  it('follows the old sidecar, which is what somebody actually arranged', () => {
    // The folder lists alphabetically; the sidecar records the run. Preferring
    // the listing would silently reorder every word that was not filmed in
    // alphabetical order, which is most of them.
    const files = [video('d1', 'a.mp4'), video('d2', 'b.mp4'), video('d3', 'c.mp4')]

    expect(orderedFiles(files, ['d3', 'd1', 'd2']).map((f) => f.id)).toEqual(['d3', 'd1', 'd2'])
  })

  it('falls back to the folder when there is no sidecar', () => {
    const files = [video('d1', 'a.mp4'), video('d2', 'b.mp4')]
    expect(orderedFiles(files, []).map((f) => f.id)).toEqual(['d1', 'd2'])
  })

  it('keeps a file the sidecar has never heard of, on the end', () => {
    // A take added after the sidecar stopped being written. Dropping it would
    // lose a video to tidiness.
    const files = [video('d1', 'a.mp4'), video('d2', 'b.mp4')]
    expect(orderedFiles(files, ['d2']).map((f) => f.id)).toEqual(['d2', 'd1'])
  })

  it('ignores a file the sidecar names that is no longer there', () => {
    const files = [video('d1', 'a.mp4')]
    expect(orderedFiles(files, ['gone', 'd1']).map((f) => f.id)).toEqual(['d1'])
  })
})

describe('when not to pair at all', () => {
  it('pairs when the counts agree', () => {
    expect(pairingProblem(3, 3)).toBeNull()
  })

  it('refuses when there are more files than takes', () => {
    expect(pairingProblem(3, 5)).toMatch(/cannot be worked out/i)
  })

  it('refuses when there are fewer', () => {
    expect(pairingProblem(3, 2)).toMatch(/cannot be worked out/i)
  })

  it('says an empty folder is empty rather than a mismatch', () => {
    expect(pairingProblem(3, 0)).toMatch(/no videos/i)
  })
})

describe('recovering a word', () => {
  it('repoints each take at the file in the same position', async () => {
    const summary = await recoverShelf({ onRepaired })

    expect(summary.recovered).toBe(3)
    expect(downloadFile.mock.calls.map((call) => call[0])).toEqual(['d1', 'd2', 'd3'])
    expect(onRepaired).toHaveBeenCalledTimes(3)
    // The take ids are untouched: the role, the order and the transcript on
    // each one are the parts that were never broken.
    expect(onRepaired.mock.calls.map((call) => call[1])).toEqual(['wv1', 'wv2', 'wv3'])
  })

  it('records the asset before repointing the take', async () => {
    // A take pointed at an asset whose upload failed looks repaired and plays
    // nothing, which is worse than staying visibly broken.
    const order: string[] = []
    recordKey.mockImplementation(() => {
      order.push('record')
      return Promise.resolve()
    })
    onRepaired.mockImplementation(() => order.push('repoint'))

    await recoverShelf({ onRepaired })

    expect(order.slice(0, 4)).toEqual(['record', 'repoint', 'record', 'repoint'])
  })

  it('leaves a word alone when its folder does not match up', async () => {
    listChildren.mockImplementation(tree([video('d1', 'a.mp4'), video('d2', 'b.mp4')]))

    const summary = await recoverShelf({ onRepaired })

    expect(summary.recovered).toBe(0)
    expect(onRepaired).not.toHaveBeenCalled()
    expect(downloadFile).not.toHaveBeenCalled()
    expect(summary.words[0]?.skipped).toMatch(/2 videos for 3 takes/i)
  })

  it('names the folder it could not find rather than failing silently', async () => {
    listChildren.mockImplementation((parentId: string) =>
      parentId === 'root' ? Promise.resolve([folder('f_other', 'ESL')]) : Promise.resolve([]),
    )

    const summary = await recoverShelf({ onRepaired })

    expect(summary.words[0]?.skipped).toMatch(/No folder named “Classical”/)
  })

  it('carries on past a word it cannot do, rather than stopping', async () => {
    // One renamed folder should not strand every word after it.
    getShelf.mockResolvedValue({
      doc: {
        ...SHELF,
        words: [
          { ...SHELF.words[0], id: 'w0', text: 'Missing', videos: [SHELF.words[0]!.videos[0]] },
          SHELF.words[0],
        ],
      },
      version: 1,
    })

    const summary = await recoverShelf({ onRepaired })

    expect(summary.words).toHaveLength(2)
    expect(summary.recovered).toBe(3)
  })

  it('refuses to start when the account has no record of the folder', async () => {
    // Which is what running 0011 does. Better to say so than to walk nothing
    // and report that everything is fine.
    getDriveFolder.mockResolvedValue(null)

    await expect(recoverShelf({ onRepaired })).rejects.toThrow(/no record of the Drive folder/i)
  })

  it('stops when asked, keeping what it has already put back', async () => {
    const controller = new AbortController()
    onRepaired.mockImplementation(() => controller.abort())

    const summary = await recoverShelf({ onRepaired, signal: controller.signal })

    expect(summary.recovered).toBe(1)
  })
})
