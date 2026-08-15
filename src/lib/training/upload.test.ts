import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sending a training set.
 *
 * Everything worth pinning down here is about a run that is *long*. Four
 * hundred photos over half an hour will meet a dropped connection, and the
 * behaviours that follow from that are the ones a later refactor is most likely
 * to undo: one refused file must not throw away the rest, a file the set already
 * holds must not be sent again, a wobble must be retried and a refusal must not
 * be, and the signatures must be minted in batches rather than all at the start
 * where the last of them would expire before it was used.
 */
vi.mock('../auth0/client', () => ({
  auth0Token: async () => 'token',
}))

vi.mock('../mock', () => ({
  isMockEnabled: () => false,
}))

const { listTrainingSet, uploadTrainingSet } = await import('./upload')
const { nameSelection } = await import('./names')

interface SignCall {
  setId: string
  names: string[]
}

const signed: SignCall[] = []
const put: string[] = []

/** What R2 answers for the next PUT of a given name, if not 200. */
const refuse = new Map<string, number[]>()
/** Names whose PUT throws, as a dropped connection does. */
const drop = new Map<string, number>()

/** Real `File`s, because the uploader rebuilds each one as a Blob to send it. */
function photos(names: string[]) {
  return nameSelection(names.map((name) => new File(['bytes'], name, { type: 'image/jpeg' }))).named
}

beforeEach(() => {
  signed.length = 0
  put.length = 0
  refuse.clear()
  drop.clear()

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (url === '/api/r2/uploads') {
      const body = JSON.parse(String(init?.body)) as {
        setId: string
        items: { name: string }[]
      }
      const names = body.items.map((item) => item.name)
      signed.push({ setId: body.setId, names })
      return new Response(
        JSON.stringify({
          prefix: `set/hash/${body.setId}/`,
          urls: names.map((name) => ({
            name,
            key: `set/hash/${body.setId}/${name}`,
            url: `https://r2.example/${name}?sig=1`,
          })),
        }),
        { status: 200 },
      )
    }

    if (url === '/api/r2/lists') {
      return new Response(JSON.stringify({ names: ['already.jpg'] }), { status: 200 })
    }

    const name = decodeURIComponent(new URL(url).pathname.slice(1))
    put.push(name)

    const drops = drop.get(name) ?? 0
    if (drops > 0) {
      drop.set(name, drops - 1)
      throw new TypeError('Failed to fetch')
    }

    const statuses = refuse.get(name)
    if (statuses && statuses.length > 0) {
      return new Response('no', { status: statuses.shift() as number })
    }

    return new Response(null, { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listTrainingSet', () => {
  it('reports the names a set already holds', async () => {
    expect(await listTrainingSet('lora')).toEqual(['already.jpg'])
  })
})

describe('uploadTrainingSet', () => {
  it('uploads each file to the URL it was signed for', async () => {
    const result = await uploadTrainingSet({
      setId: 'lora',
      files: photos(['a.jpg', 'b.jpg']),
    })

    expect(result).toEqual({ uploaded: 2, skipped: 0, failed: [] })
    expect(put.sort()).toEqual(['a.jpg', 'b.jpg'])
  })

  it('skips what the set already holds instead of storing it twice', async () => {
    // The whole of how an interrupted upload resumes: pick the same folder
    // again, and only the missing photos are sent.
    const states: string[] = []
    const result = await uploadTrainingSet({
      setId: 'lora',
      files: photos(['a.jpg', 'b.jpg', 'c.jpg']),
      already: new Set(['a.jpg', 'b.jpg']),
      onItem: (progress) => states.push(`${progress.name}:${progress.state}`),
    })

    expect(result.skipped).toBe(2)
    expect(result.uploaded).toBe(1)
    expect(put).toEqual(['c.jpg'])
    expect(states).toContain('a.jpg:skipped')
    // Not even signed for, so a skipped file costs nothing at all.
    expect(signed[0]?.names).toEqual(['c.jpg'])
  })

  it('keeps going after a file fails, and reports which ones did', async () => {
    // A run of four hundred that loses eleven has still uploaded three hundred
    // and eighty-nine, and must say so rather than throwing them all away.
    refuse.set('b.jpg', [400])

    const result = await uploadTrainingSet({
      setId: 'lora',
      files: photos(['a.jpg', 'b.jpg', 'c.jpg']),
    })

    expect(result.uploaded).toBe(2)
    expect(result.failed.map((entry) => entry.name)).toEqual(['b.jpg'])
    expect(put).toContain('a.jpg')
    expect(put).toContain('c.jpg')
  })

  it('retries a connection that dropped', async () => {
    drop.set('a.jpg', 2)

    // Fake timers because the backoff between attempts is seconds long, and a
    // test that actually waits them out is a test somebody eventually deletes.
    vi.useFakeTimers()
    try {
      const run = uploadTrainingSet({ setId: 'lora', files: photos(['a.jpg']) })
      await vi.runAllTimersAsync()
      const result = await run

      expect(result.uploaded).toBe(1)
      expect(put.filter((name) => name === 'a.jpg')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a refusal, which would be refused the same way', async () => {
    refuse.set('a.jpg', [400, 400, 400])

    const result = await uploadTrainingSet({ setId: 'lora', files: photos(['a.jpg']) })

    expect(result.failed).toHaveLength(1)
    expect(put.filter((name) => name === 'a.jpg')).toHaveLength(1)
  })

  it('signs in batches, so the last URL is as fresh as the first', async () => {
    // Every signature expires fifteen minutes after it is minted, and four
    // hundred photos do not upload in fifteen minutes.
    const names = Array.from({ length: 60 }, (_, index) => `img-${index}.jpg`)
    await uploadTrainingSet({ setId: 'lora', files: photos(names) })

    expect(signed).toHaveLength(3)
    expect(signed.map((call) => call.names.length)).toEqual([25, 25, 10])
    expect(put).toHaveLength(60)
  })

  it('stops when it is asked to', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      uploadTrainingSet({
        setId: 'lora',
        files: photos(['a.jpg']),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(put).toHaveLength(0)
  })
})
