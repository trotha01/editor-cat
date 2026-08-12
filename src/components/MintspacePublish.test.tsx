import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MintspaceAccount, PublishedVideo } from '../lib/mintspace/publish'
import type { Project, Publication } from '../lib/types'

/**
 * The Mintspace panel in the export dialog.
 *
 * The thing this has to get right is that publishing involves a *second*
 * account — one the editor has never heard of, on a site the user may not have
 * signed up to yet — and that the render is the expensive part. So the session
 * is resolved as the panel opens rather than when the button is pressed, the
 * sign-in form is offered in place rather than as a trip to another site, and a
 * failure at the end says which of the two identities was refused. A deployment
 * with no Mintspace behind it must say so plainly instead of offering a button
 * that cannot work.
 */

const configured = { value: true }
const site = { value: '' }

vi.mock('../lib/mintspace/client', () => ({
  isMintspaceConfigured: () => configured.value,
  mintspaceSiteUrl: () => site.value,
}))

const currentAccount = vi.fn<() => Promise<MintspaceAccount | null>>()
const signIn = vi.fn<(email: string, password: string) => Promise<MintspaceAccount>>()
const signOut = vi.fn<() => Promise<void>>()
const publishVideo = vi.fn<(request: unknown) => Promise<PublishedVideo>>()
const deleteVideo =
  vi.fn<(video: unknown) => Promise<{ rowDeleted: boolean; fileDeleted: boolean }>>()

vi.mock('../lib/mintspace/publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mintspace/publish')>()
  // Only the calls that would reach Mintspace are stood in for. The error
  // translation is the shipped one, because what it says is half of what this
  // panel is for.
  return {
    ...actual,
    currentAccount: () => currentAccount(),
    signIn: (email: string, password: string) => signIn(email, password),
    signOut: () => signOut(),
    publishVideo: (request: unknown) => publishVideo(request),
    deleteVideo: (video: unknown) => deleteVideo(video),
  }
})

// The digest is the duplicate check, so it is the shipped one — jsdom on Node
// has WebCrypto. Only its *input* is stubbed, by handing back distinct blobs.

const { MintspacePublish } = await import('./MintspacePublish')

const ADA: MintspaceAccount = { id: 'uid-1', email: 'ada@example.com', username: 'ada' }
const VIDEO = new Blob(['mp4'], { type: 'video/mp4' })

const PROJECT: Project = {
  id: 'p',
  name: 'p',
  clips: [],
  audioTracks: [],
  audioClips: [],
  width: 720,
  height: 1280,
  fps: 30,
}

const POSTED: Publication = {
  videoId: 'video-1',
  storagePath: 'uid-1/export_fixed.mp4',
  videoUrl: 'https://cdn.example/uid-1/export_fixed.mp4',
  digest: 'deadbeef',
  caption: 'declensions, hour 4',
  publishedAt: '2026-08-11T12:00:00.000Z',
  accountId: 'uid-1',
  username: 'ada',
}

/** The digest of VIDEO, so a project can claim to have already posted it. */
async function digestOfVideo(): Promise<string> {
  const { sha256Hex } = await import('../lib/digest')
  const digest = await sha256Hex(VIDEO)
  if (!digest) throw new Error('this environment cannot hash, so the guard cannot be tested')
  return digest
}

function setup(overrides: Partial<Parameters<typeof MintspacePublish>[0]> = {}) {
  const props = {
    render: vi.fn().mockResolvedValue(VIDEO),
    project: PROJECT,
    empty: false,
    vertical: true,
    busy: false,
    onBusyChange: vi.fn(),
    onPublished: vi.fn(),
    onForget: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<MintspacePublish {...props} />)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  configured.value = true
  site.value = ''
  currentAccount.mockResolvedValue(ADA)
  publishVideo.mockResolvedValue({
    id: 'video-1',
    videoUrl: 'https://cdn.example/uid-1/export.mp4',
    storagePath: 'uid-1/export.mp4',
    siteUrl: '',
  })
  deleteVideo.mockResolvedValue({ rowDeleted: true, fileDeleted: true })
})

describe('a deployment with no Mintspace behind it', () => {
  it('says so, rather than offering a button that cannot work', async () => {
    configured.value = false
    setup()

    expect(await screen.findByText(/no Mintspace project configured/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument()
  })

  it('does not go looking for a session it could not use', () => {
    configured.value = false
    setup()

    expect(currentAccount).not.toHaveBeenCalled()
  })
})

describe('signing in', () => {
  it('offers the form in place, so the render is not lost to a trip elsewhere', async () => {
    currentAccount.mockResolvedValue(null)
    setup()

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /publish/i })).not.toBeInTheDocument()
  })

  it('publishes as whoever just signed in', async () => {
    currentAccount.mockResolvedValue(null)
    signIn.mockResolvedValue(ADA)
    setup()

    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: 'ada@example.com' },
    })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('@ada')).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledWith('ada@example.com', 'hunter2')
  })

  it('asks for a handle only when making an account', async () => {
    currentAccount.mockResolvedValue(null)
    setup()

    fireEvent.click(await screen.findByRole('button', { name: /need an account/i }))

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument()
  })

  it('says which of the two identities was refused', async () => {
    currentAccount.mockResolvedValue(null)
    signIn.mockRejectedValue({ code: 'invalid_credentials' })
    setup()

    fireEvent.change(await screen.findByLabelText(/email/i), {
      target: { value: 'ada@example.com' },
    })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText(/did not match a Mintspace account/i)).toBeInTheDocument()
  })
})

describe('publishing', () => {
  it('renders the export and posts it with the caption', async () => {
    const props = setup()

    fireEvent.change(await screen.findByLabelText(/caption/i), {
      target: { value: 'declensions, hour 4' },
    })
    fireEvent.click(screen.getByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(publishVideo).toHaveBeenCalled())
    expect(props.render).toHaveBeenCalled()
    expect(publishVideo).toHaveBeenCalledWith(
      expect.objectContaining({ video: VIDEO, caption: 'declensions, hour 4' }),
    )
  })

  it('confirms it is up, and links the file when the build knows no site', async () => {
    setup()

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    const link = await screen.findByRole('link', { name: /open the video/i })
    expect(link).toHaveAttribute('href', 'https://cdn.example/uid-1/export.mp4')
  })

  it('links the feed itself when the build knows where it is', async () => {
    site.value = 'https://mintspace.example.com'
    setup()

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    expect(await screen.findByRole('link', { name: /open mintspace/i })).toHaveAttribute(
      'href',
      'https://mintspace.example.com',
    )
  })

  it('reports a bucket that will not take the file, and what to change about it', async () => {
    publishVideo.mockRejectedValue({ message: 'The object exceeded the maximum allowed size' })
    setup()

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    expect(await screen.findByText(/lower resolution or quality/i)).toBeInTheDocument()
  })

  it('says nothing when the render was cancelled, since that was the point', async () => {
    const props = setup({
      render: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
    })

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(props.onBusyChange).toHaveBeenLastCalledWith(false))
    expect(screen.queryByText(/could not publish/i)).not.toBeInTheDocument()
    expect(publishVideo).not.toHaveBeenCalled()
  })

  it('hands the export dialog its busy state back either way', async () => {
    publishVideo.mockRejectedValue(new Error('nope'))
    const props = setup()

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(props.onBusyChange).toHaveBeenLastCalledWith(false))
    expect(props.onBusyChange).toHaveBeenNthCalledWith(1, true)
  })

  it('has nothing to publish from an empty timeline', async () => {
    setup({ empty: true })

    expect(await screen.findByRole('button', { name: /publish to mintspace/i })).toBeDisabled()
  })
})

describe('videos this project is already up as', () => {
  const posted: Project = { ...PROJECT, publications: [POSTED] }

  it('lists them, so it is known before a minute is spent rendering', async () => {
    setup({ project: posted })

    expect(await screen.findByText(/already in the feed/i)).toBeInTheDocument()
    expect(screen.getByText('declensions, hour 4')).toBeInTheDocument()
  })

  it('refuses to post the same file a second time', async () => {
    // A project claiming to have already published this exact export.
    const project: Project = {
      ...PROJECT,
      publications: [{ ...POSTED, digest: await digestOfVideo() }],
    }
    const props = setup({ project })

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    expect(await screen.findByText(/already in the feed/i)).toBeInTheDocument()
    expect(publishVideo).not.toHaveBeenCalled()
    expect(props.onPublished).not.toHaveBeenCalled()
  })

  it('posts an edited project, because that is a different video', async () => {
    // Same project, a render that no longer hashes to what went up.
    const props = setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(publishVideo).toHaveBeenCalled())
    expect(props.onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 'video-1', storagePath: 'uid-1/export.mp4' }),
    )
  })

  it('hands back everything needed to take it down again', async () => {
    const onPublished = vi.fn<(publication: Publication) => void>()
    setup({ onPublished })

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(onPublished).toHaveBeenCalled())
    const publication = onPublished.mock.calls[0]![0]
    expect(publication.accountId).toBe('uid-1')
    expect(publication.storagePath).toBe('uid-1/export.mp4')
    // Non-empty, or nothing downstream can recognise this file again.
    expect(publication.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('deleting a published video', () => {
  const posted: Project = { ...PROJECT, publications: [POSTED] }

  it('asks first, since it is gone from the feed for good', async () => {
    setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /delete .* from mintspace/i }))

    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(deleteVideo).not.toHaveBeenCalled()
  })

  it('takes the row and the file down together', async () => {
    const props = setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /delete .* from mintspace/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete for good/i }))

    await waitFor(() => expect(deleteVideo).toHaveBeenCalled())
    expect(deleteVideo).toHaveBeenCalledWith({
      videoId: 'video-1',
      storagePath: 'uid-1/export_fixed.mp4',
      accountId: 'uid-1',
    })
    expect(props.onForget).toHaveBeenCalledWith('video-1')
  })

  it('leaves it alone when the question is answered the other way', async () => {
    setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /delete .* from mintspace/i }))
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }))

    expect(deleteVideo).not.toHaveBeenCalled()
    expect(screen.getByText('declensions, hour 4')).toBeInTheDocument()
  })

  it('keeps tracking a video it could not delete', async () => {
    deleteVideo.mockRejectedValue(
      new Error('This video was published from a different Mintspace account.'),
    )
    const props = setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /delete .* from mintspace/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete for good/i }))

    expect(await screen.findByText(/different Mintspace account/i)).toBeInTheDocument()
    // Still up, so still tracked — forgetting it here would offer to post it again.
    expect(props.onForget).not.toHaveBeenCalled()
  })

  it('forgets one that had already gone from the feed', async () => {
    deleteVideo.mockResolvedValue({ rowDeleted: false, fileDeleted: true })
    const props = setup({ project: posted })

    fireEvent.click(await screen.findByRole('button', { name: /delete .* from mintspace/i }))
    fireEvent.click(screen.getByRole('button', { name: /delete for good/i }))

    await waitFor(() => expect(props.onForget).toHaveBeenCalledWith('video-1'))
  })

  it('offers no delete button to a session that could not use one', async () => {
    currentAccount.mockResolvedValue(null)
    setup({ project: posted })

    // The record is still worth showing; the button is not.
    expect(await screen.findByText('declensions, hour 4')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
  })
})

describe('a horizontal project', () => {
  it('warns that a vertical feed will letterbox it, and where to change that', async () => {
    setup({ vertical: false })

    expect(await screen.findByText(/letterbox/i)).toBeInTheDocument()
  })

  it('says nothing about shape when the project is already vertical', async () => {
    setup()

    await screen.findByText('@ada')
    expect(screen.queryByText(/letterbox/i)).not.toBeInTheDocument()
  })
})
