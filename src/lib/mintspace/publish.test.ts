import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Publishing an export into Mintspace.
 *
 * Four things are worth holding down here, and all four are about what a
 * *stranger* sees in a feed. The upload has to land in the publisher's own
 * folder, because Mintspace's storage policy refuses anything else and a
 * refusal at that point has already cost a render. The row must never point at
 * an upload that failed, which is the one ordering here that produces a broken
 * card rather than an invisible orphan. A thumbnail that could not be uploaded
 * must not take the video down with it, since it is decoration on a nullable
 * column. And a caption nobody wrote must arrive as null rather than as a
 * caption that happens to say nothing.
 */

interface Upload {
  path: string
  blob: Blob
  options: { contentType?: string } | undefined
}

const uploads: Upload[] = []
const inserted: Record<string, unknown>[] = []

const state = {
  session: null as { user: { id: string; email: string | null } } | null,
  profile: null as Record<string, unknown> | null,
  rpcError: null as unknown,
  insertError: null as unknown,
  /** Keyed by extension, so a bucket that takes video but not stills is a case. */
  uploadErrors: {} as Record<string, unknown>,
  site: '',
}

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
  storage: {
    from: () => ({
      upload: async (path: string, blob: Blob, options: { contentType?: string } | undefined) => {
        const extension = path.slice(path.lastIndexOf('.') + 1)
        const error = state.uploadErrors[extension] ?? null
        if (!error) uploads.push({ path, blob, options })
        return { error }
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example/${path}` } }),
    }),
  },
  from: () => ({
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
  MINTSPACE_BUCKET: 'mintspace-videos',
}))

// Fixed, so the paths below can be asserted exactly. The real one is a uuid.
vi.mock('../media', () => ({ newId: (prefix: string) => `${prefix}_fixed` }))

const { CAPTION_MAX_LENGTH, currentAccount, mintspaceErrorMessage, publishVideo, signIn, signUp } =
  await import('./publish')

const VIDEO = new Blob(['mp4'], { type: 'video/mp4' })
const POSTER = new Blob(['jpeg'], { type: 'image/jpeg' })

beforeEach(() => {
  uploads.length = 0
  inserted.length = 0
  state.session = { user: { id: 'uid-1', email: 'ada@example.com' } }
  state.profile = { id: 'uid-1', username: 'ada' }
  state.rpcError = null
  state.insertError = null
  state.uploadErrors = {}
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
  it('uploads into the publisher’s own folder, which is the only one allowed', async () => {
    await publishVideo({ video: VIDEO, caption: 'hello' })

    expect(uploads).toHaveLength(1)
    expect(uploads[0]?.path).toBe('uid-1/export_fixed.mp4')
    expect(uploads[0]?.options?.contentType).toBe('video/mp4')
  })

  it('adds the row that puts it in the feed, pointing at the uploaded file', async () => {
    const result = await publishVideo({ video: VIDEO, poster: POSTER, caption: 'hello' })

    expect(inserted).toEqual([
      {
        user_id: 'uid-1',
        caption: 'hello',
        video_url: 'https://cdn.example/uid-1/export_fixed.mp4',
        poster_url: 'https://cdn.example/uid-1/export_fixed.jpg',
      },
    ])
    expect(result).toMatchObject({ id: 'video-1' })
  })

  it('keeps the thumbnail beside its video, under one name', async () => {
    await publishVideo({ video: VIDEO, poster: POSTER, caption: '' })

    expect(uploads.map((entry) => entry.path)).toEqual([
      'uid-1/export_fixed.mp4',
      'uid-1/export_fixed.jpg',
    ])
    expect(uploads[1]?.options?.contentType).toBe('image/jpeg')
  })

  it('publishes without a thumbnail rather than failing over one', async () => {
    // What a Mintspace project whose bucket predates poster support answers.
    state.uploadErrors.jpg = { message: 'mime type image/jpeg is not supported' }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      publishVideo({ video: VIDEO, poster: POSTER, caption: 'hi' }),
    ).resolves.toMatchObject({ id: 'video-1' })
    expect(inserted[0]?.poster_url).toBeNull()
  })

  it('never adds a row for an upload that failed', async () => {
    state.uploadErrors.mp4 = { message: 'The object exceeded the maximum allowed size' }

    await expect(publishVideo({ video: VIDEO, caption: 'hi' })).rejects.toBeTruthy()
    expect(inserted).toHaveLength(0)
  })

  it('files a caption nobody wrote as no caption', async () => {
    await publishVideo({ video: VIDEO, caption: '   ' })
    expect(inserted[0]?.caption).toBeNull()
  })

  it('trims the caption, since a feed shows it verbatim', async () => {
    await publishVideo({ video: VIDEO, caption: '  hello  ' })
    expect(inserted[0]?.caption).toBe('hello')
  })

  it('refuses to publish with nobody signed in, before uploading anything', async () => {
    state.session = null

    await expect(publishVideo({ video: VIDEO, caption: 'hi' })).rejects.toThrow(/Sign in/i)
    expect(uploads).toHaveLength(0)
  })

  it('reports each stage, since the whole thing outlasts a spinner’s welcome', async () => {
    const stages: string[] = []
    await publishVideo({
      video: VIDEO,
      poster: POSTER,
      caption: 'hi',
      onStage: (s) => stages.push(s),
    })

    expect(stages).toHaveLength(3)
    expect(stages[0]).toMatch(/video/i)
  })

  it('hands back where to go and see it, when the build knows', async () => {
    state.site = 'https://mintspace.example.com'
    await expect(publishVideo({ video: VIDEO, caption: 'hi' })).resolves.toMatchObject({
      siteUrl: 'https://mintspace.example.com',
    })
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
