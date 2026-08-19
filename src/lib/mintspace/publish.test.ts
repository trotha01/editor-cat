import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Publishing an export into Mintspace.
 *
 * What is worth holding down here is all about what a *stranger* sees in a
 * feed, and most of it is ordering. The row must never point at an upload that
 * failed, and within the upload the playlist must go last — those are the two
 * orderings that produce a broken card rather than an invisible orphan, and
 * they are exactly the kind of thing a later refactor inverts without noticing.
 * Beyond that: the Mintspace token rather than the Auth0 one decides whose
 * prefix the files land under, a prefix is never reused, and a caption nobody
 * wrote arrives as null rather than as a caption that happens to say nothing.
 */

interface Upload {
  scope: string
  publicationId?: string
  mintspaceToken?: string | null
  names: string[]
  contentTypes: string[]
}

const uploads: Upload[] = []
const inserted: Record<string, unknown>[] = []

const state = {
  session: null as { user: { id: string; email: string | null }; access_token?: string } | null,
  profile: null as Record<string, unknown> | null,
  rpcError: null as unknown,
  insertError: null as unknown,
  /** Thrown by the uploader, so a refused upload is a case. */
  uploadError: null as unknown,
  site: '',
  /** Rows a delete matches. Empty is what row-level security returns. */
  deleted: [{ id: 'video-1' }] as { id: string }[],
  deleteError: null as unknown,
  removeError: null as unknown,
}

const removed: { publicationId: string; keys: string[] }[] = []
const deletedIds: string[] = []

const signInWithPassword = vi.fn(async () => ({ error: null as unknown }))
const signUpWith = vi.fn(async () => ({ data: { session: {} as unknown }, error: null as unknown }))
const signOutWith = vi.fn(async () => ({ error: null as unknown }))

const client = {
  auth: {
    getSession: async () => ({ data: { session: state.session } }),
    signInWithPassword,
    signUp: signUpWith,
    signOut: signOutWith,
  },
  rpc: async (name: string) => {
    if (name !== 'ensure_profile') throw new Error(`unexpected rpc ${name}`)
    return { data: state.profile, error: state.rpcError }
  },
  from: () => ({
    delete: () => ({
      eq: (_column: string, value: string) => ({
        select: async () => {
          deletedIds.push(value)
          return { data: state.deleteError ? null : state.deleted, error: state.deleteError }
        },
      }),
    }),
    insert: (row: Record<string, unknown>) => {
      inserted.push(row)
      return {
        select: () => ({
          single: async () => ({
            data: state.insertError ? null : { id: 'video-1' },
            error: state.insertError,
          }),
        }),
      }
    },
  }),
}

vi.mock('./client', () => ({
  mintspace: () => client,
  mintspaceSiteUrl: () => state.site,
}))

vi.mock('../r2/client', () => ({
  isR2Configured: () => true,
  publicUrl: (key: string) => `https://cdn.example/${key}`,
}))

vi.mock('../r2/upload', () => ({
  uploadFiles: async (request: {
    scope: string
    publicationId?: string
    mintspaceToken?: string | null
    files: { name: string; contentType: string }[]
  }) => {
    if (state.uploadError) throw state.uploadError
    uploads.push({
      scope: request.scope,
      publicationId: request.publicationId,
      mintspaceToken: request.mintspaceToken,
      names: request.files.map((file) => file.name),
      contentTypes: request.files.map((file) => file.contentType),
    })
    const prefix = `v1/uid-1/${request.publicationId}/`
    return {
      prefix,
      objects: request.files.map((file) => ({ name: file.name, key: `${prefix}${file.name}` })),
    }
  },
  deletePublication: async (options: { publicationId: string; keys: string[] }) => {
    removed.push({ publicationId: options.publicationId, keys: options.keys })
    if (state.removeError) throw state.removeError
    return { deleted: options.keys.length, failed: [] }
  },
}))

// Fixed, so the paths below can be asserted exactly. The real one is a uuid.
vi.mock('../media', () => ({ newId: (prefix: string) => `${prefix}_fixed` }))

const {
  CAPTION_MAX_LENGTH,
  currentAccount,
  deleteVideo,
  mintspaceErrorMessage,
  publishVideo,
  signIn,
  signUp,
} = await import('./publish')

/** A package as renderProject hands it over: segments, init, playlist last. */
const HLS = {
  playlist: '#EXTM3U\n',
  files: [
    {
      name: 'seg00001.m4s',
      blob: new Blob(['a'], { type: 'video/iso.segment' }),
      contentType: 'video/iso.segment',
    },
    {
      name: 'seg00002.m4s',
      blob: new Blob(['b'], { type: 'video/iso.segment' }),
      contentType: 'video/iso.segment',
    },
    { name: 'init.mp4', blob: new Blob(['i'], { type: 'video/mp4' }), contentType: 'video/mp4' },
    {
      name: 'index.m3u8',
      blob: new Blob(['#EXTM3U'], { type: 'application/vnd.apple.mpegurl' }),
      contentType: 'application/vnd.apple.mpegurl',
    },
  ],
}

const POSTER = new Blob(['jpg'], { type: 'image/jpeg' })

beforeEach(() => {
  uploads.length = 0
  inserted.length = 0
  removed.length = 0
  deletedIds.length = 0
  state.deleted = [{ id: 'video-1' }]
  state.deleteError = null
  state.removeError = null
  state.session = { user: { id: 'uid-1', email: 'ada@example.com' }, access_token: 'ms-token' }
  state.profile = { id: 'uid-1', username: 'ada' }
  state.rpcError = null
  state.insertError = null
  state.uploadError = null
  state.site = ''
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('currentAccount', () => {
  it('is nobody when there is no Mintspace session', async () => {
    state.session = null
    await expect(currentAccount()).resolves.toBeNull()
  })

  it('names the account by the profile Mintspace hands back', async () => {
    await expect(currentAccount()).resolves.toEqual({
      id: 'uid-1',
      email: 'ada@example.com',
      username: 'ada',
    })
  })

  it('still answers when the profile comes back without a handle', async () => {
    // The post belongs to the same account either way; only the label is
    // missing, and a label is not worth failing a publish over.
    state.profile = { id: 'uid-1' }
    await expect(currentAccount()).resolves.toMatchObject({ id: 'uid-1', username: 'you' })
  })
})

describe('publishVideo', () => {
  it('uploads the package under a prefix of its own', async () => {
    await publishVideo({ hls: HLS, caption: 'hello' })

    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.scope).toBe('publication')
    expect(uploads[0]?.publicationId).toBe('export_fixed')
  })

  it('sends the Mintspace token, which is what decides whose prefix it is', async () => {
    // Not the Auth0 one. The feed row is owned by the Mintspace account, and
    // keying the objects by the other identity is what would let a later delete
    // remove the row, derive a different prefix, find nothing, and say it
    // worked.
    await publishVideo({ hls: HLS, caption: 'hello' })
    expect(uploads[0]?.mintspaceToken).toBe('ms-token')
  })

  it('uploads the playlist last', async () => {
    // The ordering that matters most: a playlist which exists has to imply its
    // segments exist, or the feed shows a card that spins forever.
    await publishVideo({ hls: HLS, caption: 'hello' })

    expect(uploads[0]?.names.at(-1)).toBe('index.m3u8')
    expect(uploads[0]?.names).toEqual(['seg00001.m4s', 'seg00002.m4s', 'init.mp4', 'index.m3u8'])
  })

  it('puts the poster before the playlist too', async () => {
    // Same reasoning one step further: once the playlist lands the row can be
    // written, and a row whose poster is still uploading is a blank card.
    await publishVideo({ hls: HLS, poster: POSTER, caption: 'hello' })

    const names = uploads[0]?.names ?? []
    expect(names.indexOf('poster.jpg')).toBeLessThan(names.indexOf('index.m3u8'))
    expect(names.at(-1)).toBe('index.m3u8')
  })

  it('points the feed row at the playlist', async () => {
    const result = await publishVideo({ hls: HLS, caption: 'hello' })

    expect(inserted[0]).toMatchObject({
      user_id: 'uid-1',
      caption: 'hello',
      video_url: 'https://cdn.example/v1/uid-1/export_fixed/index.m3u8',
    })
    expect(result).toMatchObject({ id: 'video-1' })
  })

  it('records where the bytes live on the row itself', async () => {
    // The only authoritative record of what is still referenced. Mintspace's
    // own retention purge deletes rows without touching storage and has no
    // credentials to clean up with, so without this a purged video's objects
    // are unenumerable garbage.
    await publishVideo({ hls: HLS, caption: 'hello' })
    expect(inserted[0]?.storage_prefix).toBe('v1/uid-1/export_fixed/')
  })

  it('sends a poster when there is one', async () => {
    await publishVideo({ hls: HLS, poster: POSTER, caption: 'hello' })
    expect(inserted[0]?.poster_url).toBe('https://cdn.example/v1/uid-1/export_fixed/poster.jpg')
  })

  it('leaves poster_url off the row rather than sending null for it', async () => {
    // The feed falls back to the video's own first frame, so a column left
    // alone says the same thing a null would and takes no view on the future.
    await publishVideo({ hls: HLS, caption: 'hello' })
    expect(inserted[0]).not.toHaveProperty('poster_url')
  })

  it('hands back every key it wrote, so teardown never has to ask', async () => {
    const result = await publishVideo({ hls: HLS, caption: 'hello' })

    expect(result.keys).toEqual([
      'v1/uid-1/export_fixed/seg00001.m4s',
      'v1/uid-1/export_fixed/seg00002.m4s',
      'v1/uid-1/export_fixed/init.mp4',
      'v1/uid-1/export_fixed/index.m3u8',
    ])
    expect(result.prefix).toBe('v1/uid-1/export_fixed/')
  })

  it('never adds a row for an upload that failed', async () => {
    state.uploadError = new Error('R2 refused "seg00001.m4s" (403).')

    await expect(publishVideo({ hls: HLS, caption: 'hi' })).rejects.toBeTruthy()
    expect(inserted).toHaveLength(0)
  })

  it('files a caption nobody wrote as no caption', async () => {
    await publishVideo({ hls: HLS, caption: '   ' })
    expect(inserted[0]?.caption).toBeNull()
  })

  it('trims the caption, since a feed shows it verbatim', async () => {
    await publishVideo({ hls: HLS, caption: '  hello  ' })
    expect(inserted[0]?.caption).toBe('hello')
  })

  it('refuses to publish with nobody signed in, before uploading anything', async () => {
    state.session = null

    await expect(publishVideo({ hls: HLS, caption: 'hi' })).rejects.toThrow(/Sign in/i)
    expect(uploads).toHaveLength(0)
  })

  it('reports each stage, since the whole thing outlasts a spinner’s welcome', async () => {
    const stages: string[] = []
    await publishVideo({ hls: HLS, caption: 'hi', onStage: (s) => stages.push(s) })

    expect(stages.length).toBeGreaterThanOrEqual(2)
    expect(stages[0]).toMatch(/video/i)
    expect(stages.at(-1)).toMatch(/feed/i)
  })

  it('hands back where to go and see it, when the build knows', async () => {
    state.site = 'https://mintspace.example.com'
    await expect(publishVideo({ hls: HLS, caption: 'hi' })).resolves.toMatchObject({
      siteUrl: 'https://mintspace.example.com',
    })
  })
})

describe('deleteVideo', () => {
  const MINE = {
    videoId: 'video-1',
    publicationId: 'export_fixed',
    r2Keys: ['v1/uid-1/export_fixed/index.m3u8', 'v1/uid-1/export_fixed/seg00001.m4s'],
    accountId: 'uid-1',
  }

  it('takes the row out of the feed, then the files out of the bucket', async () => {
    await expect(deleteVideo(MINE)).resolves.toEqual({ rowDeleted: true, fileDeleted: true })

    expect(deletedIds).toEqual(['video-1'])
    expect(removed).toEqual([{ publicationId: 'export_fixed', keys: MINE.r2Keys }])
  })

  it('refuses one published by another account, before touching anything', async () => {
    // Row-level security would refuse this silently — zero rows, no error — so
    // going ahead would report success over a video still in the feed.
    await expect(deleteVideo({ ...MINE, accountId: 'somebody-else' })).rejects.toThrow(
      /different Mintspace account/i,
    )
    expect(deletedIds).toHaveLength(0)
    expect(removed).toHaveLength(0)
  })

  it('reports a row that had already gone, without calling it a failure', async () => {
    state.deleted = []

    await expect(deleteVideo(MINE)).resolves.toMatchObject({ rowDeleted: false })
    // The files still go: objects with no row are unreachable, not harmless.
    expect(removed).toHaveLength(1)
  })

  it('counts the post as gone even when its files would not delete', async () => {
    state.removeError = new Error('nope')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(deleteVideo(MINE)).resolves.toEqual({ rowDeleted: true, fileDeleted: false })
  })

  it('needs a session, since it is somebody’s own video', async () => {
    state.session = null
    await expect(deleteVideo(MINE)).rejects.toThrow(/Sign in/i)
  })
})

describe('signing in', () => {
  it('resolves the account behind a fresh session', async () => {
    await expect(signIn('ada@example.com', 'hunter2')).resolves.toMatchObject({ username: 'ada' })
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'hunter2',
    })
  })

  it('passes the wanted handle to the trigger that names the profile', async () => {
    await signUp('ada@example.com', 'hunter2', 'ada')

    expect(signUpWith).toHaveBeenCalledWith(
      expect.objectContaining({ options: { data: { username: 'ada' } } }),
    )
  })

  it('reports a sign-up that has to confirm an address before it can post', async () => {
    signUpWith.mockResolvedValueOnce({ data: { session: null }, error: null })

    await expect(signUp('ada@example.com', 'hunter2', 'ada')).resolves.toEqual({
      needsConfirmation: true,
      account: null,
    })
  })
})

describe('mintspaceErrorMessage', () => {
  it('explains a project that never ran the schema, and one that did not expose it', () => {
    expect(mintspaceErrorMessage({ code: '42P01' })).toMatch(/schema\.sql/)
    expect(mintspaceErrorMessage({ code: 'PGRST106' })).toMatch(/Exposed schemas/)
  })

  it('turns a bucket limit into the setting that can be changed about it', () => {
    expect(
      mintspaceErrorMessage({ message: 'The object exceeded the maximum allowed size' }),
    ).toMatch(/resolution or quality/)
  })

  it('says which of the two identities was refused', () => {
    expect(mintspaceErrorMessage({ code: 'invalid_credentials' })).toMatch(/Mintspace account/)
  })

  it('names the caption limit the database enforces', () => {
    expect(mintspaceErrorMessage({ code: '23514' })).toContain(String(CAPTION_MAX_LENGTH))
  })

  it('does not report a connection that was never made as a rejection', () => {
    expect(mintspaceErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach/)
  })

  it('falls back to whatever the error did say', () => {
    expect(mintspaceErrorMessage({ message: 'something specific' })).toBe('something specific')
  })
})
