import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MintspaceAccount, PublishedVideo } from '../lib/mintspace/publish'

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

vi.mock('../lib/mintspace/client', () => ({
  isMintspaceConfigured: () => configured.value,
}))

const currentAccount = vi.fn<() => Promise<MintspaceAccount | null>>()
const signIn = vi.fn<(email: string, password: string) => Promise<MintspaceAccount>>()
const signOut = vi.fn<() => Promise<void>>()
const publishVideo = vi.fn<(request: unknown) => Promise<PublishedVideo>>()

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
  }
})

const posterFrame = vi.fn<() => Promise<Blob | null>>()
vi.mock('../lib/export/posterFrame', () => ({ posterFrame: () => posterFrame() }))

const { MintspacePublish } = await import('./MintspacePublish')

const ADA: MintspaceAccount = { id: 'uid-1', email: 'ada@example.com', username: 'ada' }
const VIDEO = new Blob(['mp4'], { type: 'video/mp4' })
const POSTER = new Blob(['jpeg'], { type: 'image/jpeg' })

function setup(overrides: Partial<Parameters<typeof MintspacePublish>[0]> = {}) {
  const props = {
    render: vi.fn().mockResolvedValue(VIDEO),
    posterAt: 1,
    empty: false,
    vertical: true,
    busy: false,
    onBusyChange: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<MintspacePublish {...props} />)
  return props
}

beforeEach(() => {
  vi.clearAllMocks()
  configured.value = true
  currentAccount.mockResolvedValue(ADA)
  posterFrame.mockResolvedValue(POSTER)
  publishVideo.mockResolvedValue({
    id: 'video-1',
    videoUrl: 'https://cdn.example/uid-1/export.mp4',
    siteUrl: '',
  })
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
  it('renders, grabs a thumbnail, and posts the caption', async () => {
    const props = setup()

    fireEvent.change(await screen.findByLabelText(/caption/i), {
      target: { value: 'declensions, hour 4' },
    })
    fireEvent.click(screen.getByRole('button', { name: /publish to mintspace/i }))

    await waitFor(() => expect(publishVideo).toHaveBeenCalled())
    expect(props.render).toHaveBeenCalled()
    expect(publishVideo).toHaveBeenCalledWith(
      expect.objectContaining({ video: VIDEO, poster: POSTER, caption: 'declensions, hour 4' }),
    )
  })

  it('confirms it is up, and links the file when the build knows no site', async () => {
    setup()

    fireEvent.click(await screen.findByRole('button', { name: /publish to mintspace/i }))

    const link = await screen.findByRole('link', { name: /open the video/i })
    expect(link).toHaveAttribute('href', 'https://cdn.example/uid-1/export.mp4')
  })

  it('links the feed itself when it does know', async () => {
    publishVideo.mockResolvedValue({
      id: 'video-1',
      videoUrl: 'https://cdn.example/uid-1/export.mp4',
      siteUrl: 'https://mintspace.example.com',
    })
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
