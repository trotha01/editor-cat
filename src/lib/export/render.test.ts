import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The packaging seam in renderProject.
 *
 * ffmpeg itself is faked — running the real wasm core belongs to the end-to-end
 * test, which drives a real browser and parses the bytes that come out. What is
 * worth pinning down here is everything *around* the exec calls, because it is
 * ordinary bookkeeping that fails quietly: which files are read back, in what
 * order they are handed to the uploader, and whether the filesystem is left
 * clean between runs.
 */

interface FakeFile {
  bytes: Uint8Array
}

class FakeFFmpeg {
  files = new Map<string, FakeFile>()
  dirs = new Set<string>()
  execs: string[][] = []
  deleted: string[] = []
  deletedDirs: string[] = []
  listDirCalls: string[] = []
  handlers = new Map<string, ((payload: unknown) => void)[]>()
  /** What the packaging exec should produce, keyed by full path. */
  produces: Record<string, string> = {}
  execResult = 0

  on(event: string, handler: (payload: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  off(event: string, handler: (payload: unknown) => void) {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
    )
  }

  async load() {}

  async writeFile(name: string, bytes: Uint8Array) {
    this.files.set(name, { bytes })
  }

  async readFile(name: string): Promise<Uint8Array> {
    const file = this.files.get(name)
    if (!file) throw new Error(`ENOENT: ${name}`)
    return file.bytes
  }

  async deleteFile(name: string) {
    if (!this.files.has(name)) throw new Error(`ENOENT: ${name}`)
    this.files.delete(name)
    this.deleted.push(name)
  }

  async createDir(name: string) {
    this.dirs.add(name)
  }

  async deleteDir(name: string) {
    this.dirs.delete(name)
    this.deletedDirs.push(name)
  }

  async listDir(name: string) {
    this.listDirCalls.push(name)
    if (!this.dirs.has(name)) throw new Error(`ENOENT: ${name}`)
    return [...this.files.keys()]
      .filter((path) => path.startsWith(`${name}/`))
      .map((path) => ({ name: path.slice(name.length + 1), isDir: false }))
  }

  async exec(args: string[]) {
    this.execs.push(args)
    if (this.execResult !== 0) return this.execResult

    const output = args.at(-1) as string
    if (output.endsWith('.m3u8')) {
      for (const [path, body] of Object.entries(this.produces)) {
        this.files.set(path, { bytes: new TextEncoder().encode(body) })
      }
    } else {
      this.files.set(output, { bytes: new Uint8Array([1, 2, 3]) })
    }
    return 0
  }

  terminate() {}
}

let fake: FakeFFmpeg

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    constructor() {
      return fake as unknown as object
    }
  },
}))

vi.mock('@ffmpeg/util', () => ({
  fetchFile: async () => new Uint8Array([0]),
}))

vi.mock('./probe', () => ({ hasAudioStream: async () => false }))

const { renderProject, disposeRenderer } = await import('./render')

const PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
seg00001.m4s
#EXTINF:2.000000,
seg00002.m4s
#EXT-X-ENDLIST
`

function request(overrides: Record<string, unknown> = {}) {
  return {
    clips: [{ assetId: 'a1', kind: 'video' as const, inPoint: 0, duration: 5 }],
    audio: [],
    assets: new Map([
      ['a1', { id: 'a1', blob: new Blob([new Uint8Array([1])]), mimeType: 'video/mp4' }],
    ]),
    width: 1080,
    height: 1920,
    fps: 30,
    ...overrides,
  }
}

function packagedFiles() {
  return {
    '/hls/index.m3u8': PLAYLIST,
    '/hls/init.mp4': 'init-bytes',
    '/hls/seg00001.m4s': 'one',
    '/hls/seg00002.m4s': 'two',
  }
}

beforeEach(() => {
  fake = new FakeFFmpeg()
  fake.produces = packagedFiles()
})

afterEach(() => {
  disposeRenderer()
  vi.clearAllMocks()
})

describe('without hls', () => {
  it('runs one pass and returns no package', async () => {
    const result = await renderProject(request())

    expect(fake.execs).toHaveLength(1)
    expect(result.hls).toBeUndefined()
    expect(result.poster).toBeUndefined()
  })

  it('forces no keyframes, so the argv is what it always was', async () => {
    await renderProject(request())
    expect(fake.execs[0]).not.toContain('-force_key_frames')
  })
})

describe('with hls', () => {
  it('forces keyframes on the encode so the copy can cut cleanly', async () => {
    await renderProject(request({ hls: {} }))
    expect(fake.execs[0]).toContain('-force_key_frames')
  })

  it('packages in the same session, without re-staging the mp4', async () => {
    // Writing the finished file back into a heap that never shrinks is the
    // out-of-memory this design exists to avoid.
    await renderProject(request({ hls: {} }))

    const writes = [...fake.files.keys()]
    expect(writes).not.toContain('hls-input.mp4')
    // encode, package, poster
    expect(fake.execs).toHaveLength(3)
  })

  it('returns the segments, then the init segment, then the playlist', async () => {
    // This is the order it must be uploaded in: a playlist that exists has to
    // imply its segments exist, or a feed card spins forever.
    const result = await renderProject(request({ hls: {} }))

    expect(result.hls?.files.map((file) => file.name)).toEqual([
      'seg00001.m4s',
      'seg00002.m4s',
      'init.mp4',
      'index.m3u8',
    ])
  })

  it('labels every file with what the uploader will sign', async () => {
    const result = await renderProject(request({ hls: {} }))
    expect(result.hls?.files.map((file) => file.contentType)).toEqual([
      'video/iso.segment',
      'video/iso.segment',
      'video/mp4',
      'application/vnd.apple.mpegurl',
    ])
  })

  it('normalises an absolute segment URI out of the playlist', async () => {
    // ffmpeg derives the URI from the path it was handed; an absolute one
    // resolves against the CDN root, which 404s only in production.
    fake.produces = {
      ...packagedFiles(),
      '/hls/index.m3u8': PLAYLIST.replace(/seg0000/g, '/hls/seg0000').replace(
        'URI="init.mp4"',
        'URI="/hls/init.mp4"',
      ),
    }

    const result = await renderProject(request({ hls: {} }))
    expect(result.hls?.playlist).toBe(PLAYLIST)
    expect(result.hls?.playlist).not.toContain('/hls/')
  })

  it('extracts a poster', async () => {
    const result = await renderProject(request({ hls: {} }))
    expect(result.poster).toBeInstanceOf(Blob)
    expect(result.poster?.type).toBe('image/jpeg')
  })

  it('publishes without a poster rather than failing the export', async () => {
    // The feed falls back to its own first decoded frame, which is what it does
    // today. Losing the still is not worth losing the render over.
    const realExec = fake.exec.bind(fake)
    fake.exec = async (args: string[]) => {
      if (args.includes('-frames:v')) {
        fake.execs.push(args)
        return 1
      }
      return realExec(args)
    }

    const result = await renderProject(request({ hls: {} }))
    expect(result.hls).toBeDefined()
    expect(result.poster).toBeUndefined()
  })

  it('refuses a playlist with no segments rather than uploading it', async () => {
    // A playlist that parses but names nothing would upload cleanly and play as
    // a black screen — worth catching here rather than in the feed.
    fake.produces = { '/hls/index.m3u8': '#EXTM3U\n#EXT-X-ENDLIST\n' }
    await expect(renderProject(request({ hls: {} }))).rejects.toThrow(/playlist with no segments/i)
  })

  it('reports a packaging exit code with ffmpeg’s own tail', async () => {
    fake.execResult = 1
    await expect(renderProject(request({ hls: {} }))).rejects.toThrow(/exited with code 1/i)
  })
})

describe('the shared filesystem', () => {
  it('sweeps stale segments before packaging, not only after', async () => {
    // The cleanup in `finally` is best-effort — every delete is wrapped in a
    // catch — so a run that failed partway can leave segments behind. Segments
    // are discovered by listing the directory, so a stale one would be swept
    // into the next publication: somebody else's frames in your video.
    fake.dirs.add('/hls')
    fake.files.set('/hls/seg99999.m4s', { bytes: new TextEncoder().encode('stale') })

    const result = await renderProject(request({ hls: {} }))

    expect(fake.listDirCalls).toContain('/hls')
    expect(result.hls?.files.map((file) => file.name)).not.toContain('seg99999.m4s')
    expect(fake.deleted).toContain('/hls/seg99999.m4s')
  })

  it('leaves nothing behind when it finishes', async () => {
    await renderProject(request({ hls: {} }))
    expect([...fake.files.keys()]).toEqual([])
  })

  it('leaves nothing behind when it throws', async () => {
    fake.execResult = 1
    await expect(renderProject(request({ hls: {} }))).rejects.toThrow()
    expect([...fake.files.keys()]).toEqual([])
  })

  it('frees its directories after their contents', async () => {
    await renderProject(request({ hls: {} }))
    expect(fake.deletedDirs).toContain('/hls')
  })

  it('frees the fonts directory, which used to leak', async () => {
    await renderProject(
      request({
        captions: {
          ass: '[Script Info]',
          fonts: [{ fileName: 'f.ttf', bytes: new Uint8Array([1]) }],
        },
      }),
    )
    expect(fake.deletedDirs).toContain('/fonts')
  })

  it('unhooks its progress handler', async () => {
    await renderProject(request({ hls: {} }))
    expect(fake.handlers.get('progress') ?? []).toHaveLength(0)
  })
})

describe('progress', () => {
  it('reports packaging as its own phase rather than rewinding the bar', async () => {
    const phases: string[] = []
    await renderProject(request({ hls: {} }), {
      onProgress: ({ phase }) => phases.push(phase),
    })

    expect(phases).toContain('encoding')
    expect(phases).toContain('packaging')
    // Packaging must come after encoding and before done, or the bar walks
    // backwards in front of the user.
    expect(phases.lastIndexOf('encoding')).toBeLessThan(phases.indexOf('packaging'))
    expect(phases.indexOf('packaging')).toBeLessThan(phases.lastIndexOf('done'))
  })
})

/**
 * A render of the soundtrack on its own.
 *
 * The bookkeeping around it is what can fail quietly: a file named .mp4 that
 * holds an M4A, a still staged into the wasm heap for an export that will never
 * draw it, or a streaming package built out of something no feed can play.
 */
describe('audio only', () => {
  function audioRequest(overrides: Record<string, unknown> = {}) {
    return request({
      clips: [{ assetId: 'a1', kind: 'image' as const, inPoint: 0, duration: 5 }],
      audio: [{ assetId: 's1', startTime: 0, inPoint: 0, duration: 5, volume: 1 }],
      assets: new Map([
        ['a1', { id: 'a1', blob: new Blob([new Uint8Array([1])]), mimeType: 'image/png' }],
        ['s1', { id: 's1', blob: new Blob([new Uint8Array([2])]), mimeType: 'audio/mpeg' }],
      ]),
      audioOnly: true,
      ...overrides,
    })
  }

  it('writes an M4A, and hands it back as audio', async () => {
    const result = await renderProject(audioRequest())

    expect(fake.execs[0]?.at(-1)).toBe('editor-cat-export.m4a')
    expect(result.blob.type).toBe('audio/mp4')
  })

  it('stages no pictures, which it was never going to draw', async () => {
    await renderProject(audioRequest())

    // Read off the cleanup, which is where every staged file ends up: the
    // filesystem itself is swept bare by the time the render returns.
    expect(fake.deleted).toContain('s1.mp3')
    expect(fake.deleted).not.toContain('a1.png')
  })

  it('makes no streaming package even when one is asked for', async () => {
    const result = await renderProject(audioRequest({ hls: {} }))

    expect(fake.execs).toHaveLength(1)
    expect(result.hls).toBeUndefined()
    expect(fake.execs[0]).not.toContain('-force_key_frames')
  })
})
