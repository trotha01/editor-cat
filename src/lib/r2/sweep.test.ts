import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Working out which stored files nothing wants.
 *
 * Every test here is really the same test: that "unused" means *established as
 * unreferenced*, never *not seen*. The sweep's next move is to delete what it
 * did not mention, so a source that quietly answers with nothing is a source
 * that deletes somebody's media — and the two are indistinguishable from the
 * outside unless the failure is loud.
 */
const getShelf = vi.fn()
const listAssets = vi.fn()
const deleteAssets = vi.fn()
const listProjects = vi.fn()
const listArchivedProjects = vi.fn()
const getProject = vi.fn()
const auth0Token = vi.fn()

vi.mock('../supabase/shelf', () => ({ getShelf: () => getShelf() as unknown }))
vi.mock('../supabase/assets', () => ({
  listAssets: () => listAssets() as unknown,
  deleteAssets: (ids: readonly string[]) => deleteAssets(ids) as unknown,
}))
vi.mock('../supabase/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../supabase/projects')>()),
  listProjects: () => listProjects() as unknown,
  listArchivedProjects: () => listArchivedProjects() as unknown,
  getProject: (id: string) => getProject(id) as unknown,
}))
vi.mock('../auth0/client', () => ({ auth0Token: () => auth0Token() as unknown }))
vi.mock('../mock', () => ({ isMockEnabled: () => false }))

const { assetIdOf, sweepUnused, unusedFiles } = await import('./sweep')

const PREFIX = 'asset/hash/'

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'video',
    name: `${id}.mp4`,
    mime_type: 'video/mp4',
    width: null,
    height: null,
    duration: null,
    prompt: null,
    source_url: null,
    r2_key: `${PREFIX}${id}`,
    byte_size: 100,
    created_at: '2026-08-11T12:00:00.000Z',
    ...extra,
  }
}

/** A stored project whose doc references the given assets from its timeline. */
function project(id: string, assetIds: string[]) {
  return {
    id,
    name: id,
    doc: {
      clips: assetIds.map((assetId, index) => ({
        id: `clip_${index}`,
        assetId,
        inPoint: 0,
        outPoint: 1,
      })),
      audioTracks: [],
      audioClips: [],
      width: 720,
      height: 1280,
      fps: 30,
    },
    schemaVersion: 5,
    version: 1,
    updatedAt: '2026-08-11T12:00:00.000Z',
  }
}

let fetchMock: ReturnType<typeof vi.fn>

/** The bucket, as `/api/r2/listing` reports it. */
function bucketHolds(ids: string[]) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith('/listing')) {
      return Promise.resolve(
        new Response(JSON.stringify({ keys: ids.map((id) => `${PREFIX}${id}`) }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  auth0Token.mockResolvedValue('token')
  getShelf.mockResolvedValue(null)
  listProjects.mockResolvedValue([])
  listArchivedProjects.mockResolvedValue([])
  getProject.mockResolvedValue(null)
  listAssets.mockResolvedValue([])
  deleteAssets.mockResolvedValue(undefined)
  bucketHolds([])
})

describe('what counts as a reference', () => {
  it('spares an asset a word still uses', async () => {
    getShelf.mockResolvedValue({
      doc: {
        tiers: [],
        languages: [],
        words: [
          { id: 'w1', languageId: 'l1', text: 'gato', videos: [{ id: 'wv1', assetId: 'a1' }] },
        ],
      },
      version: 1,
    })
    listAssets.mockResolvedValue([row('a1'), row('a2')])

    const found = await unusedFiles()

    expect(found.assets.map((asset) => asset.id)).toEqual(['a2'])
  })

  it('spares an asset a project still uses', async () => {
    listProjects.mockResolvedValue([{ id: 'p1' }])
    getProject.mockResolvedValue(project('p1', ['a1']))
    listAssets.mockResolvedValue([row('a1'), row('a2')])

    const found = await unusedFiles()

    expect(found.assets.map((asset) => asset.id)).toEqual(['a2'])
  })

  it('spares an asset only an *archived* project uses', async () => {
    // The one that would be silent data loss. A deleted project is restorable
    // for ninety days, so its media is still spoken for — and it is exactly the
    // media nothing else mentions.
    listArchivedProjects.mockResolvedValue([{ id: 'p_gone' }])
    getProject.mockResolvedValue(project('p_gone', ['a1']))
    listAssets.mockResolvedValue([row('a1')])

    const found = await unusedFiles()

    expect(found.assets).toEqual([])
  })

  it("spares an asset in a project's library that no clip uses yet", async () => {
    // Generated last week and not cut in. Still that project's file.
    listProjects.mockResolvedValue([{ id: 'p1' }])
    getProject.mockResolvedValue({
      ...project('p1', []),
      doc: { ...project('p1', []).doc, libraryAssetIds: ['a1'] },
    })
    listAssets.mockResolvedValue([row('a1')])

    await expect(unusedFiles()).resolves.toMatchObject({ assets: [] })
  })
})

describe('a question that could not be answered', () => {
  /**
   * Each of these used to be the same bug waiting to happen: a source that
   * fails, is caught, and contributes no references — after which every file it
   * would have spoken for looks unused.
   */
  it('gives up rather than sweeping when the shelf cannot be read', async () => {
    getShelf.mockRejectedValue(new Error('network'))
    listAssets.mockResolvedValue([row('a1')])

    await expect(unusedFiles()).rejects.toThrow(/network/)
  })

  it('gives up when the project list cannot be read', async () => {
    listProjects.mockRejectedValue(new Error('network'))

    await expect(unusedFiles()).rejects.toThrow(/network/)
  })

  it('gives up when one project of many cannot be read', async () => {
    listProjects.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    getProject.mockResolvedValueOnce(project('p1', ['a1'])).mockRejectedValueOnce(new Error('nope'))
    listAssets.mockResolvedValue([row('a1'), row('a2')])

    await expect(unusedFiles()).rejects.toThrow(/nope/)
  })

  it('gives up when the bucket will not list', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 500 }))

    await expect(unusedFiles()).rejects.toThrow(/could not list/i)
  })
})

describe('objects with no row behind them', () => {
  it('finds residue nothing else can name', async () => {
    // An asset is reached through its row, so an object whose row is gone is
    // unreachable by every code path. A listing is the only thing that can say
    // it is there.
    listAssets.mockResolvedValue([row('a1')])
    listProjects.mockResolvedValue([{ id: 'p1' }])
    getProject.mockResolvedValue(project('p1', ['a1']))
    bucketHolds(['a1', 'a_ghost'])

    const found = await unusedFiles()

    expect(found.assets).toEqual([])
    expect(found.strayKeys).toEqual([`${PREFIX}a_ghost`])
  })

  it('reads the id off the end of a key', () => {
    expect(assetIdOf('asset/1c67802841ec97b6cff05dca050ed625/asset_abc')).toBe('asset_abc')
  })
})

describe('removing what was found', () => {
  it('forgets the rows before the objects', async () => {
    // If the row goes and the objects fail, what is left is residue the next run
    // finds. The other way round leaves a row pointing at nothing, which shows
    // up as a file that will not load.
    const order: string[] = []
    deleteAssets.mockImplementation(() => {
      order.push('rows')
      return Promise.resolve()
    })
    fetchMock.mockImplementation(() => {
      order.push('objects')
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    await sweepUnused({
      assets: [{ id: 'a1', name: 'a1.mp4', key: `${PREFIX}a1`, bytes: 100 }],
      strayKeys: [],
      bytes: 100,
    })

    expect(order).toEqual(['rows', 'objects'])
  })

  it('removes residue as well as the rows it found', async () => {
    const summary = await sweepUnused({
      assets: [{ id: 'a1', name: 'a1.mp4', key: `${PREFIX}a1`, bytes: 100 }],
      strayKeys: [`${PREFIX}a_ghost`],
      bytes: 100,
    })

    expect(summary).toEqual({ assets: 1, objects: 2, bytes: 100 })
  })

  it('still forgets a row whose upload never finished', async () => {
    // No key to delete, but the row is as unreferenced as any other and would
    // otherwise be reported for ever.
    const summary = await sweepUnused({
      assets: [{ id: 'a1', name: 'a1.mp4', key: null, bytes: 0 }],
      strayKeys: [],
      bytes: 0,
    })

    expect(deleteAssets).toHaveBeenCalledWith(['a1'])
    expect(summary.objects).toBe(0)
  })

  it('deletes exactly what it was handed, not a fresh answer', async () => {
    // What is on screen is what the person agreed to. Recomputing here would
    // let the set widen between the question and the answer.
    await sweepUnused({ assets: [], strayKeys: [], bytes: 0 })

    expect(listAssets).not.toHaveBeenCalled()
    expect(getShelf).not.toHaveBeenCalled()
  })
})
