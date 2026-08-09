import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const accessToken = vi.fn<() => Promise<string>>()
const invalidateToken = vi.fn()

vi.mock('./gis', () => ({
  accessToken: () => accessToken(),
  invalidateToken: () => invalidateToken(),
}))

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

const { createFolder, findFolder, FOLDER_MIME, folderUrl, kindForMime, renameFolder } =
  await import('./drive')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** The URL of one call, parsed, since everything interesting is in the query. */
function requestUrl(index = 0): URL {
  return new URL(String(fetchMock.mock.calls[index]?.[0]))
}

function requestInit(index = 0): RequestInit {
  return fetchMock.mock.calls[index]?.[1] ?? {}
}

function bearer(index = 0): unknown {
  return (requestInit(index).headers as Record<string, string> | undefined)?.Authorization
}

beforeEach(() => {
  vi.clearAllMocks()
  accessToken.mockResolvedValue('token-1')
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('kindForMime', () => {
  it('maps the media types the editor can use', () => {
    expect(kindForMime('image/png')).toBe('image')
    expect(kindForMime('video/mp4')).toBe('video')
    expect(kindForMime('audio/webm;codecs=opus')).toBe('audio')
  })

  it('rejects anything else, so Docs and folders never reach the library', () => {
    // The Picker can be pointed at a folder view, and a stray Doc in a media
    // folder should be ignored rather than downloaded as a video.
    expect(kindForMime('application/vnd.google-apps.document')).toBeNull()
    expect(kindForMime('application/vnd.google-apps.folder')).toBeNull()
    expect(kindForMime('application/pdf')).toBeNull()
  })
})

describe('createFolder', () => {
  it('makes the folder inside the parent it was handed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'folder_9', name: 'Sea shanty' }))

    expect(await createFolder('Sea shanty', 'parent_1')).toEqual({
      id: 'folder_9',
      name: 'Sea shanty',
    })
    expect(JSON.parse(String(requestInit().body))).toMatchObject({
      name: 'Sea shanty',
      mimeType: FOLDER_MIME,
      parents: ['parent_1'],
    })
  })
})

describe('renameFolder', () => {
  it('patches the name and nothing else, so the folder and its contents stay put', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'folder_9', name: 'Sea shanty (final)' }))

    await renameFolder('folder_9', 'Sea shanty (final)')

    expect(requestInit().method).toBe('PATCH')
    expect(requestUrl().pathname).toMatch(/\/files\/folder_9$/)
    expect(JSON.parse(String(requestInit().body))).toEqual({ name: 'Sea shanty (final)' })
  })
})

describe('findFolder', () => {
  it('asks for a live folder of that name directly inside the parent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [{ id: 'folder_9', name: 'Sea shanty' }] }))

    expect(await findFolder('Sea shanty', 'parent_1')).toEqual({
      id: 'folder_9',
      name: 'Sea shanty',
    })

    const q = requestUrl().searchParams.get('q') ?? ''
    expect(q).toContain("name = 'Sea shanty'")
    expect(q).toContain(`mimeType = '${FOLDER_MIME}'`)
    expect(q).toContain("'parent_1' in parents")
    // A folder in the bin is not a folder to save into: it would be found, then
    // uploaded to, and then vanish with the bin.
    expect(q).toContain('trashed = false')
  })

  it('is null when there is nothing there, so the caller makes one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [] }))

    expect(await findFolder('Sea shanty', 'parent_1')).toBeNull()
  })

  it('escapes a name that would otherwise close the quote', async () => {
    // Folder names are project names, and project names are typed by the user.
    fetchMock.mockResolvedValue(jsonResponse({ files: [] }))

    await findFolder("Bob's cut", 'parent_1')

    expect(requestUrl().searchParams.get('q')).toContain("name = 'Bob\\'s cut'")
  })

  it('skips a folder another project has already claimed', async () => {
    // Two projects called "Untitled project" is the ordinary case rather than an
    // edge one: every project is born with that name, so the first project's
    // folder matches the second project's search perfectly. Adopting it would
    // pour both projects' media into one folder.
    fetchMock.mockResolvedValue(
      jsonResponse({
        files: [
          { id: 'folder_first', name: 'Untitled project' },
          { id: 'folder_second', name: 'Untitled project' },
        ],
      }),
    )

    expect(await findFolder('Untitled project', 'parent_1', ['folder_first'])).toEqual({
      id: 'folder_second',
      name: 'Untitled project',
    })
  })

  it('finds nothing when every match belongs to another project', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ files: [{ id: 'folder_first', name: 'Untitled project' }] }),
    )

    // Null rather than the one folder there is: the caller then creates its own
    // beside it, which is the correct outcome for a project that has none.
    expect(await findFolder('Untitled project', 'parent_1', ['folder_first'])).toBeNull()
  })
})

describe('an authenticated Drive request', () => {
  it('mints a fresh token and retries once on 401', async () => {
    // Tokens stop working for reasons the expiry clock cannot see: a revoked
    // grant, a password change, a session signed out in another tab.
    accessToken.mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid Credentials' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))

    await findFolder('Sea shanty', 'parent_1')

    expect(invalidateToken).toHaveBeenCalledOnce()
    expect(bearer(0)).toBe('Bearer stale')
    expect(bearer(1)).toBe('Bearer fresh')
  })

  it('gives up on a second 401, which is not staleness', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Invalid Credentials' } }, 401))

    await expect(findFolder('Sea shanty', 'parent_1')).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('Reconnect Drive'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off and retries a 429', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'folder_9', name: 'Sea shanty' }] }))

    const pending = findFolder('Sea shanty', 'parent_1')
    await vi.advanceTimersByTimeAsync(2000)

    expect(await pending).toEqual({ id: 'folder_9', name: 'Sea shanty' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reads a 403 whose reason is a rate limit as "slow down" rather than "no"', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ files: [] }))

    const pending = findFolder('Sea shanty', 'parent_1')
    await vi.advanceTimersByTimeAsync(2000)

    await pending
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 403 that is an actual refusal', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'Insufficient permission' } }, 403),
    )

    await expect(findFolder('Sea shanty', 'parent_1')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 5xx, because a create that failed may still have applied', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Backend Error' } }, 500))

    await expect(createFolder('Sea shanty', 'parent_1')).rejects.toMatchObject({ status: 500 })
    // The whole reason `findFolder` exists: a retry here is how a project ends
    // up with two folders, so the recovery is to look the first one up later
    // rather than to ask again now.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('folderUrl', () => {
  it('points at the folder in the Drive web UI', () => {
    expect(folderUrl('folder_9')).toBe('https://drive.google.com/drive/folders/folder_9')
  })
})
