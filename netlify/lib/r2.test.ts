import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type R2Config,
  deleteKeys,
  listPrefix,
  objectUrl,
  presignGet,
  presignPut,
  r2Config,
} from './r2'

const CONFIG: R2Config = {
  accountId: 'acct123',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  publicBucket: 'editor-cat-media',
  privateBucket: 'editor-cat-private',
}

/** Pinned so a signature is reproducible rather than a function of the clock. */
const AT = '20260814T000000Z'

describe('r2Config', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('R2_')) delete process.env[key]
    }
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('is null until every value is set, so a half-configured site degrades', () => {
    expect(r2Config()).toBeNull()

    process.env.R2_ACCOUNT_ID = 'acct123'
    process.env.R2_ACCESS_KEY_ID = 'key'
    process.env.R2_SECRET_ACCESS_KEY = 'secret'
    process.env.R2_BUCKET_PUBLIC = 'pub'
    // Still missing the private bucket.
    expect(r2Config()).toBeNull()

    process.env.R2_BUCKET_PRIVATE = 'priv'
    expect(r2Config()).toEqual({
      accountId: 'acct123',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      publicBucket: 'pub',
      privateBucket: 'priv',
    })
  })

  it('ignores whitespace, which is how a pasted secret usually arrives', () => {
    process.env.R2_ACCOUNT_ID = ' acct123 '
    process.env.R2_ACCESS_KEY_ID = 'key'
    process.env.R2_SECRET_ACCESS_KEY = 'secret'
    process.env.R2_BUCKET_PUBLIC = 'pub'
    process.env.R2_BUCKET_PRIVATE = 'priv'
    expect(r2Config()?.accountId).toBe('acct123')
  })

  it('treats an empty variable as unset rather than as a credential', () => {
    process.env.R2_ACCOUNT_ID = 'acct123'
    process.env.R2_ACCESS_KEY_ID = '   '
    process.env.R2_SECRET_ACCESS_KEY = 'secret'
    process.env.R2_BUCKET_PUBLIC = 'pub'
    process.env.R2_BUCKET_PRIVATE = 'priv'
    expect(r2Config()).toBeNull()
  })
})

describe('objectUrl', () => {
  it('addresses the right bucket for each kind', () => {
    expect(objectUrl(CONFIG, 'public', 'v1/uid/pub/index.m3u8')).toBe(
      'https://acct123.r2.cloudflarestorage.com/editor-cat-media/v1/uid/pub/index.m3u8',
    )
    expect(objectUrl(CONFIG, 'private', 'asset/hash/asset_1')).toBe(
      'https://acct123.r2.cloudflarestorage.com/editor-cat-private/asset/hash/asset_1',
    )
  })

  it('keeps the key separators as separators', () => {
    // Encoding the whole key would turn the slashes into %2F and put every
    // object at the bucket root under a very long name.
    expect(objectUrl(CONFIG, 'public', 'a/b/c.m4s')).toContain('/editor-cat-media/a/b/c.m4s')
  })
})

describe('presignPut', () => {
  it('produces a SigV4 query signature with the parameters R2 expects', async () => {
    const url = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/init.mp4', {
        contentType: 'video/mp4',
        datetime: AT,
      }),
    )

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Date')).toBe(AT)
    // Region `auto` and service `s3` are what R2 signs against; anything else
    // fails the signature rather than routing somewhere surprising.
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      `${CONFIG.accessKeyId}/20260814/auto/s3/aws4_request`,
    )
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('signs content-type, so a signed URL cannot store something else', async () => {
    // The point of pinning it: without content-type in SignedHeaders, an upload
    // URL for a segment would equally accept text/html, and the public bucket
    // sits on a domain of ours.
    const url = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/init.mp4', {
        contentType: 'video/mp4',
        datetime: AT,
      }),
    )
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host')
  })

  it('signs a different signature for a different content type', async () => {
    const asMp4 = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/init.mp4', {
        contentType: 'video/mp4',
        datetime: AT,
      }),
    ).searchParams.get('X-Amz-Signature')
    const asHtml = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/init.mp4', {
        contentType: 'text/html',
        datetime: AT,
      }),
    ).searchParams.get('X-Amz-Signature')

    expect(asMp4).not.toBe(asHtml)
  })

  it('expires, and says so in the URL', async () => {
    const url = new URL(
      await presignPut(CONFIG, 'private', 'asset/hash/a1', {
        contentType: 'video/mp4',
        expiresIn: 900,
        datetime: AT,
      }),
    )
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
  })

  it('signs each key separately', async () => {
    const one = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/seg00001.m4s', {
        contentType: 'video/iso.segment',
        datetime: AT,
      }),
    ).searchParams.get('X-Amz-Signature')
    const two = new URL(
      await presignPut(CONFIG, 'public', 'v1/uid/pub/seg00002.m4s', {
        contentType: 'video/iso.segment',
        datetime: AT,
      }),
    ).searchParams.get('X-Amz-Signature')

    expect(one).not.toBe(two)
  })

  it('is reproducible for the same inputs', async () => {
    const args = ['public', 'v1/uid/pub/init.mp4'] as const
    const once = await presignPut(CONFIG, ...args, { contentType: 'video/mp4', datetime: AT })
    const twice = await presignPut(CONFIG, ...args, { contentType: 'video/mp4', datetime: AT })
    expect(once).toBe(twice)
  })
})

describe('presignGet', () => {
  it('signs only host, since a GET sends no content type', async () => {
    const url = new URL(await presignGet(CONFIG, 'private', 'asset/hash/a1', { datetime: AT }))
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('defaults to a window long enough for a large take on a slow line', async () => {
    const url = new URL(await presignGet(CONFIG, 'private', 'asset/hash/a1', { datetime: AT }))
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeGreaterThanOrEqual(900)
  })
})

function xmlListing(keys: string[], nextToken?: string): string {
  return `<?xml version="1.0"?><ListBucketResult>${keys
    .map((key) => `<Contents><Key>${key}</Key></Contents>`)
    .join('')}<IsTruncated>${nextToken ? 'true' : 'false'}</IsTruncated>${
    nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''
  }</ListBucketResult>`
}

describe('listPrefix', () => {
  it('reads the keys out of a listing', async () => {
    const fake = async () =>
      new Response(xmlListing(['v1/uid/pub/index.m3u8', 'v1/uid/pub/init.mp4']), { status: 200 })

    await expect(
      listPrefix(CONFIG, 'public', 'v1/uid/pub/', fake as typeof fetch),
    ).resolves.toEqual(['v1/uid/pub/index.m3u8', 'v1/uid/pub/init.mp4'])
  })

  it('follows continuation tokens', async () => {
    // A long video runs past one page, and a teardown that silently stopped at
    // the first thousand objects would report success over most of the files.
    const pages = [
      xmlListing(['a/1'], 'token-2'),
      xmlListing(['a/2'], 'token-3'),
      xmlListing(['a/3']),
    ]
    let call = 0
    const fake = async () => new Response(pages[call++], { status: 200 })

    await expect(listPrefix(CONFIG, 'public', 'a/', fake as typeof fetch)).resolves.toEqual([
      'a/1',
      'a/2',
      'a/3',
    ])
    expect(call).toBe(3)
  })

  it('sends the prefix and a signature', async () => {
    let seen: Request | undefined
    const fake = async (request: Request) => {
      seen = request
      return new Response(xmlListing([]), { status: 200 })
    }

    await listPrefix(CONFIG, 'public', 'v1/uid/pub/', fake as unknown as typeof fetch)
    const url = new URL(seen!.url)
    expect(url.searchParams.get('prefix')).toBe('v1/uid/pub/')
    expect(url.searchParams.get('list-type')).toBe('2')
    expect(seen!.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
  })

  it('throws rather than reporting an empty prefix when R2 refuses', async () => {
    // Reporting "no objects" for a listing that failed would make a teardown
    // claim it removed everything.
    const fake = async () => new Response('nope', { status: 403 })
    await expect(listPrefix(CONFIG, 'public', 'a/', fake as typeof fetch)).rejects.toThrow(/403/)
  })
})

describe('deleteKeys', () => {
  it('removes every key it is given', async () => {
    const seen: string[] = []
    const fake = async (request: Request) => {
      seen.push(new URL(request.url).pathname)
      return new Response(null, { status: 204 })
    }

    const outcome = await deleteKeys(
      CONFIG,
      'public',
      ['v1/uid/pub/a.m4s', 'v1/uid/pub/b.m4s'],
      fake as unknown as typeof fetch,
    )

    expect(outcome.deleted.sort()).toEqual(['v1/uid/pub/a.m4s', 'v1/uid/pub/b.m4s'])
    expect(outcome.failed).toEqual([])
    expect(seen).toHaveLength(2)
  })

  it('counts a missing object as deleted, so a retry finishes', async () => {
    // The case that actually happens: teardown half-succeeded, and the second
    // attempt meets objects that are already gone.
    const fake = async () => new Response(null, { status: 404 })
    const outcome = await deleteKeys(CONFIG, 'public', ['a'], fake as typeof fetch)
    expect(outcome.deleted).toEqual(['a'])
    expect(outcome.failed).toEqual([])
  })

  it('reports what it could not remove instead of throwing', async () => {
    // An orphan is worth knowing about, but it must not fail the whole teardown
    // — the row is already gone and the post is already down.
    const fake = async (request: Request) =>
      new URL(request.url).pathname.endsWith('bad')
        ? new Response(null, { status: 500 })
        : new Response(null, { status: 204 })

    const outcome = await deleteKeys(
      CONFIG,
      'public',
      ['good', 'bad'],
      fake as unknown as typeof fetch,
    )
    expect(outcome.deleted).toEqual(['good'])
    expect(outcome.failed).toEqual([{ key: 'bad', reason: 'R2 answered 500' }])
  })

  it('survives a request that throws', async () => {
    const fake = async () => {
      throw new TypeError('Failed to fetch')
    }
    const outcome = await deleteKeys(CONFIG, 'public', ['a'], fake as unknown as typeof fetch)
    expect(outcome.deleted).toEqual([])
    expect(outcome.failed[0]?.reason).toContain('Failed to fetch')
  })

  it('does nothing, successfully, when given nothing', async () => {
    const outcome = await deleteKeys(CONFIG, 'public', [], (async () => {
      throw new Error('should not be called')
    }) as unknown as typeof fetch)
    expect(outcome).toEqual({ deleted: [], failed: [] })
  })
})
