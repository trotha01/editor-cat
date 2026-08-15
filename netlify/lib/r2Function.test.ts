import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The routing and refusals in `netlify/functions/r2.ts`.
 *
 * Lives here rather than beside the handler because Netlify turns every file in
 * the functions directory into a deployable endpoint — see functionNames.test.ts.
 *
 * Signing is covered by r2.test.ts and key derivation by r2Keys.test.ts, so both
 * are left real; only the two token verifiers are mocked, because standing up a
 * tenant and a Supabase project to test a 401 proves nothing. What is worth
 * pinning down here is the part that exists nowhere else: that nothing anonymous
 * gets a URL, that a client cannot name the prefix it writes to, and that a key
 * belonging to another account is refused rather than signed.
 */
const requireSession = vi.fn()
const mintspaceUser = vi.fn()

vi.mock('./auth', () => ({
  requireSession: (request: Request) => requireSession(request) as unknown,
}))

vi.mock('./mintspaceToken', async () => {
  const actual = await vi.importActual<typeof import('./mintspaceToken')>('./mintspaceToken')
  return {
    ...actual,
    mintspaceUser: (token: string, config: unknown) => mintspaceUser(token, config) as unknown,
  }
})

const handler = (await import('../functions/r2')).default

const AUTH0_SUB = 'google-oauth2|104372000000000000000'
const MINTSPACE_UID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'

function post(route: string, payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://site.example/api/r2/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer auth0', ...headers },
    body: JSON.stringify(payload),
  })
}

const WITH_MINTSPACE = { 'x-mintspace-authorization': 'Bearer mintspace' }

const SEGMENTS = [
  { name: 'index.m3u8', contentType: 'application/vnd.apple.mpegurl', bytes: 300 },
  { name: 'init.mp4', contentType: 'video/mp4', bytes: 900 },
  { name: 'seg00001.m4s', contentType: 'video/iso.segment', bytes: 100_000 },
]

beforeEach(() => {
  requireSession.mockResolvedValue({ ok: true, userId: AUTH0_SUB, email: null })
  mintspaceUser.mockResolvedValue({ id: MINTSPACE_UID })

  process.env.R2_ACCOUNT_ID = 'acct123'
  process.env.R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  process.env.R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  process.env.R2_BUCKET_PUBLIC = 'editor-cat-media'
  process.env.R2_BUCKET_PRIVATE = 'editor-cat-private'
  process.env.R2_BUCKET_TRAINING = 'editor-cat-training'
  process.env.MINTSPACE_SUPABASE_URL = 'https://mintspace.supabase.co'
})

afterEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('R2_') || key.startsWith('MINTSPACE_')) delete process.env[key]
  }
})

describe('the endpoint as a whole', () => {
  it('refuses anything but POST', async () => {
    const response = await handler(
      new Request('https://site.example/api/r2/uploads', { method: 'GET' }),
    )
    expect(response.status).toBe(405)
  })

  it('refuses a caller with no session', async () => {
    requireSession.mockResolvedValue({
      ok: false,
      response: new Response('nope', { status: 401 }),
    })
    const response = await handler(post('uploads', { scope: 'asset', items: SEGMENTS }))
    expect(response.status).toBe(401)
  })

  it('says so when the deployment has no R2 behind it', async () => {
    delete process.env.R2_ACCOUNT_ID
    const response = await handler(post('uploads', { scope: 'asset', items: [] }))
    expect(response.status).toBe(503)
    // An operator problem, named so it can be fixed.
    expect(JSON.stringify(await response.json())).toContain('R2_ACCOUNT_ID')
  })

  it('404s an unknown route', async () => {
    expect((await handler(post('whatever', {}))).status).toBe(404)
  })

  it('never lets a signed URL be cached', async () => {
    // The response body is a set of credentials with an expiry. Anything between
    // us and the browser holding on to one is a credential outliving its
    // request.
    const response = await handler(
      post('uploads', {
        scope: 'asset',
        items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

describe('POST /api/r2/uploads', () => {
  it('signs a URL per object under a prefix the caller never named', async () => {
    const response = await handler(
      post(
        'uploads',
        { scope: 'publication', publicationId: 'export_abc', items: SEGMENTS },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      prefix: string
      bucket: string
      urls: { name: string; key: string; url: string }[]
    }

    // Built from the verified Mintspace uid, not from anything in the request.
    expect(body.prefix).toBe(`v1/${MINTSPACE_UID}/export_abc/`)
    expect(body.bucket).toBe('public')
    expect(body.urls.map((entry) => entry.key)).toEqual([
      `v1/${MINTSPACE_UID}/export_abc/index.m3u8`,
      `v1/${MINTSPACE_UID}/export_abc/init.mp4`,
      `v1/${MINTSPACE_UID}/export_abc/seg00001.m4s`,
    ])
    for (const entry of body.urls) {
      expect(new URL(entry.url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('ignores a prefix the client tries to supply', async () => {
    const response = await handler(
      post(
        'uploads',
        {
          scope: 'publication',
          publicationId: 'export_abc',
          // None of these are read. If any ever were, this endpoint would become
          // a way to write into somebody else's namespace.
          prefix: 'v1/someone-else/',
          key: 'v1/someone-else/index.m3u8',
          bucket: 'public',
          items: [SEGMENTS[0]],
        },
        WITH_MINTSPACE,
      ),
    )

    const body = (await response.json()) as { prefix: string; urls: { key: string }[] }
    expect(body.prefix).toBe(`v1/${MINTSPACE_UID}/export_abc/`)
    expect(body.urls[0]?.key).toBe(`v1/${MINTSPACE_UID}/export_abc/index.m3u8`)
  })

  it('puts asset uploads in the private bucket under a hashed subject', async () => {
    const response = await handler(
      post('uploads', {
        scope: 'asset',
        items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
      }),
    )

    const body = (await response.json()) as { prefix: string; bucket: string }
    expect(body.bucket).toBe('private')
    expect(body.prefix).toMatch(/^asset\/[0-9a-f]{32}\/$/)
    // The raw Auth0 subject must not appear in a key.
    expect(body.prefix).not.toContain('google-oauth2')
  })

  it('refuses a traversal in a name', async () => {
    for (const name of ['../../other/x.m4s', 'nested/seg.m4s', '..', '%2e%2e']) {
      const response = await handler(
        post(
          'uploads',
          {
            scope: 'publication',
            publicationId: 'export_abc',
            items: [{ name, contentType: 'video/mp4', bytes: 1 }],
          },
          WITH_MINTSPACE,
        ),
      )
      expect(response.status, `should refuse "${name}"`).toBe(400)
    }
  })

  it('refuses a traversal in the publication id', async () => {
    const response = await handler(
      post(
        'uploads',
        { scope: 'publication', publicationId: '../..', items: [SEGMENTS[0]] },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(400)
  })

  it('refuses an empty publication id, which would widen the prefix', async () => {
    const response = await handler(
      post(
        'uploads',
        { scope: 'publication', publicationId: '', items: [SEGMENTS[0]] },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(400)
  })

  it('refuses a content type that would host a page on our own domain', async () => {
    const response = await handler(
      post(
        'uploads',
        {
          scope: 'publication',
          publicationId: 'export_abc',
          items: [{ name: 'index.html', contentType: 'text/html', bytes: 10 }],
        },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(400)
  })

  it('refuses more objects than it will sign at once', async () => {
    const items = Array.from({ length: 600 }, (_, index) => ({
      name: `seg${index}.m4s`,
      contentType: 'video/iso.segment',
      bytes: 1,
    }))
    const response = await handler(
      post('uploads', { scope: 'publication', publicationId: 'p', items }, WITH_MINTSPACE),
    )
    expect(response.status).toBe(400)
  })

  it('refuses one oversized object and an oversized batch', async () => {
    const huge = await handler(
      post('uploads', {
        scope: 'asset',
        items: [{ name: 'big', contentType: 'video/mp4', bytes: 900 * 1024 * 1024 }],
      }),
    )
    expect(huge.status).toBe(400)

    const many = await handler(
      post('uploads', {
        scope: 'asset',
        items: Array.from({ length: 20 }, (_, index) => ({
          name: `a${index}`,
          contentType: 'video/mp4',
          bytes: 400 * 1024 * 1024,
        })),
      }),
    )
    expect(many.status).toBe(400)
  })

  it('refuses an unknown scope and a malformed body', async () => {
    expect((await handler(post('uploads', { scope: 'whatever', items: [] }))).status).toBe(400)
    expect(
      (
        await handler(
          new Request('https://site.example/api/r2/uploads', {
            method: 'POST',
            headers: { authorization: 'Bearer auth0' },
            body: 'not json',
          }),
        )
      ).status,
    ).toBe(400)
  })

  describe('the Mintspace half of a publication upload', () => {
    it('refuses when no Mintspace token is sent', async () => {
      const response = await handler(
        post('uploads', { scope: 'publication', publicationId: 'p', items: [SEGMENTS[0]] }),
      )
      expect(response.status).toBe(401)
    })

    it('refuses when the Mintspace token does not verify', async () => {
      mintspaceUser.mockResolvedValue(null)
      const response = await handler(
        post(
          'uploads',
          { scope: 'publication', publicationId: 'p', items: [SEGMENTS[0]] },
          WITH_MINTSPACE,
        ),
      )
      expect(response.status).toBe(401)
    })

    it('reports an unreachable Mintspace as an outage, not a bad sign-in', async () => {
      // Sending someone round a login that was never the problem is the failure
      // worth ruling out here.
      mintspaceUser.mockRejectedValue(new Error('keys unreachable'))
      const response = await handler(
        post(
          'uploads',
          { scope: 'publication', publicationId: 'p', items: [SEGMENTS[0]] },
          WITH_MINTSPACE,
        ),
      )
      expect(response.status).toBe(502)
    })

    it('does not ask for a Mintspace token on an asset upload', async () => {
      const response = await handler(
        post('uploads', {
          scope: 'asset',
          items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
        }),
      )
      expect(response.status).toBe(200)
      expect(mintspaceUser).not.toHaveBeenCalled()
    })
  })
})

describe('a training set', () => {
  const PHOTOS = [
    { name: 'img-0001.jpg', contentType: 'image/jpeg', bytes: 3_000_000 },
    { name: 'img-0002.heic', contentType: 'image/heic', bytes: 2_000_000 },
  ]

  it('signs into the training bucket under a prefix the caller never named', async () => {
    const response = await handler(
      post('uploads', {
        scope: 'training',
        setId: 'my-cat-lora',
        // Read by nothing. The set name is the only part of the prefix a client
        // contributes, and it is one validated segment.
        prefix: 'set/someone-else/',
        items: PHOTOS,
      }),
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      prefix: string
      bucket: string
      urls: { key: string; url: string }[]
    }

    expect(body.bucket).toBe('training')
    expect(body.prefix).toMatch(/^set\/[0-9a-f]{32}\/my-cat-lora\/$/)
    expect(body.prefix).not.toContain('google-oauth2')
    expect(body.urls[0]?.key).toBe(`${body.prefix}img-0001.jpg`)
    expect(new URL(body.urls[1]!.url).host).toContain('acct123')
    expect(new URL(body.urls[1]!.url).pathname).toContain('/editor-cat-training/')
  })

  it('needs no Mintspace token — this is not a publication', async () => {
    const response = await handler(
      post('uploads', { scope: 'training', setId: 'lora', items: PHOTOS }),
    )
    expect(response.status).toBe(200)
    expect(mintspaceUser).not.toHaveBeenCalled()
  })

  it('names the missing variable when the site has no training bucket', async () => {
    delete process.env.R2_BUCKET_TRAINING

    const refused = await handler(
      post('uploads', { scope: 'training', setId: 'lora', items: PHOTOS }),
    )
    expect(refused.status).toBe(503)
    expect(JSON.stringify(await refused.json())).toContain('R2_BUCKET_TRAINING')

    // And the rest of the app is untouched by that: the training bucket is the
    // one this deployment may not have.
    const asset = await handler(
      post('uploads', {
        scope: 'asset',
        items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
      }),
    )
    expect(asset.status).toBe(200)
  })

  it('refuses a set name that is not one safe segment', async () => {
    for (const setId of ['../..', 'a/b', 'a.b', '', 'my lora']) {
      const response = await handler(post('uploads', { scope: 'training', setId, items: PHOTOS }))
      expect(response.status, `should refuse "${setId}"`).toBe(400)
    }
  })

  it('refuses a set with no name at all, which would widen the prefix', async () => {
    const response = await handler(post('uploads', { scope: 'training', items: PHOTOS }))
    expect(response.status).toBe(400)
  })

  it('stores stills and clips, but not audio or anything that renders', async () => {
    for (const contentType of ['audio/mpeg', 'text/html', 'image/svg+xml']) {
      const response = await handler(
        post('uploads', {
          scope: 'training',
          setId: 'lora',
          items: [{ name: 'x.bin', contentType, bytes: 10 }],
        }),
      )
      expect(response.status, `should refuse ${contentType}`).toBe(400)
    }
  })

  it('lists what a set already holds, as bare names', async () => {
    // The listing is what makes an interrupted upload of four hundred photos
    // resumable, so the shape it comes back in is worth pinning down.
    // R2 itself is the one thing not stood up here, so the bucket's answer is
    // built from whatever prefix the handler actually asked about — which is
    // also how the prefix derivation gets checked on this path.
    const asked: string[] = []
    const listed = vi.fn(async (request: Request) => {
      const prefix = new URL(request.url).searchParams.get('prefix') ?? ''
      asked.push(prefix)
      return new Response(
        `<?xml version="1.0"?><ListBucketResult>
           <Key>${prefix}img-0001.jpg</Key>
           <Key>${prefix}img-0002.jpg</Key>
           <IsTruncated>false</IsTruncated>
         </ListBucketResult>`,
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', listed)

    try {
      const response = await handler(post('lists', { scope: 'training', setId: 'lora' }))
      expect(response.status).toBe(200)

      const body = (await response.json()) as { prefix: string; names: string[] }
      expect(body.prefix).toMatch(/^set\/[0-9a-f]{32}\/lora\/$/)
      expect(asked).toEqual([body.prefix])
      // Bare names, because what the browser holds is names: it compares them
      // against the files it is about to send.
      expect(body.names).toEqual(['img-0001.jpg', 'img-0002.jpg'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('will not list anything but a training set', async () => {
    // Publications are public and the asset prefix is the account's whole
    // library; neither is something this endpoint enumerates.
    expect((await handler(post('lists', { scope: 'asset' }))).status).toBe(400)
    expect(
      (await handler(post('lists', { scope: 'publication', publicationId: 'p' }, WITH_MINTSPACE)))
        .status,
    ).toBe(400)
  })

  it('refuses to delete a key belonging to another account', async () => {
    const response = await handler(
      post('deletes', {
        scope: 'training',
        setId: 'lora',
        keys: ['set/00000000000000000000000000000000/lora/img-0001.jpg'],
      }),
    )
    expect(response.status).toBe(403)
  })
})

describe('POST /api/r2/downloads', () => {
  it('signs a GET for the caller’s own object', async () => {
    const uploaded = (await (
      await handler(
        post('uploads', {
          scope: 'asset',
          items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
        }),
      )
    ).json()) as { urls: { key: string }[] }

    const response = await handler(post('downloads', { keys: [uploaded.urls[0]?.key] }))
    expect(response.status).toBe(200)

    const body = (await response.json()) as { urls: { url: string }[] }
    expect(new URL(body.urls[0]!.url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a key under somebody else’s prefix', async () => {
    const response = await handler(
      post('downloads', { keys: ['asset/00000000000000000000000000000000/theirs'] }),
    )
    expect(response.status).toBe(403)
  })

  it('refuses a key that climbs out of the prefix', async () => {
    const uploaded = (await (
      await handler(
        post('uploads', {
          scope: 'asset',
          items: [{ name: 'asset_1', contentType: 'video/mp4', bytes: 10 }],
        }),
      )
    ).json()) as { prefix: string }

    const response = await handler(post('downloads', { keys: [`${uploaded.prefix}../../etc`] }))
    expect(response.status).toBe(403)
  })

  it('refuses a public-bucket key outright', async () => {
    // The public bucket is served from a custom domain and needs no signature,
    // so a signed URL for it would be a credential handed out for nothing.
    const response = await handler(post('downloads', { keys: [`v1/${MINTSPACE_UID}/p/init.mp4`] }))
    expect(response.status).toBe(403)
  })
})

describe('POST /api/r2/deletes', () => {
  it('refuses keys outside the caller’s publication prefix', async () => {
    const response = await handler(
      post(
        'deletes',
        {
          scope: 'publication',
          publicationId: 'export_abc',
          keys: ['v1/someone-else/export_abc/init.mp4'],
        },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(403)
  })

  it('refuses a publication id that is not one segment', async () => {
    const response = await handler(
      post('deletes', { scope: 'publication', publicationId: '../..', keys: [] }, WITH_MINTSPACE),
    )
    expect(response.status).toBe(400)
  })

  it('needs a verified Mintspace session, same as publishing', async () => {
    mintspaceUser.mockResolvedValue(null)
    const response = await handler(
      post(
        'deletes',
        { scope: 'publication', publicationId: 'export_abc', keys: [] },
        WITH_MINTSPACE,
      ),
    )
    expect(response.status).toBe(401)
  })
})
