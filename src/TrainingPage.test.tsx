/**
 * The training uploader, from the page rather than from its parts.
 *
 * What is asserted here is the promise the page makes to somebody with four
 * hundred photos and a connection that will drop at least once: it says what a
 * file will be *called* before sending it, it does not offer to send what the
 * set already holds, and it never sends anything under a set name the endpoint
 * would refuse. The naming rules themselves are tested in lib/training, and the
 * uploader's retries beside it; this is about what reaches the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const listTrainingSet = vi.fn()
const uploadTrainingSet = vi.fn()

vi.mock('./lib/training/upload', async (importOriginal) => {
  const original = await importOriginal<typeof import('./lib/training/upload')>()
  return {
    ...original,
    listTrainingSet: (...args: unknown[]) => listTrainingSet(...args) as unknown,
    uploadTrainingSet: (...args: unknown[]) => uploadTrainingSet(...args) as unknown,
  }
})

// Reached by the Settings dialog, which this page can open.
vi.mock('./lib/db', () => ({
  estimateUsage: () => Promise.resolve(null),
  clearAll: () => Promise.resolve(),
  formatBytes: () => '0 B',
}))

const { TrainingPage } = await import('./TrainingPage')

/** The debounce before the page asks the bucket what a set holds. */
const LISTING_DELAY = 600

function photo(name: string): File {
  return new File(['bytes'], name, { type: 'image/jpeg' })
}

/** Puts files into the picker, which is how a folder is chosen. */
function choose(files: File[]): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  window.localStorage.clear()
  listTrainingSet.mockResolvedValue([])
  uploadTrainingSet.mockResolvedValue({ uploaded: 0, skipped: 0, failed: [] })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function settleListing(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(LISTING_DELAY)
  })
}

describe('the training page', () => {
  it('says what each file will be called before it sends anything', async () => {
    render(<TrainingPage />)
    await settleListing()

    // The name in the bucket is not the name on disk, and somebody looking for
    // the photo later needs to know which one it became.
    choose([photo('IMG_0142 (1).JPG')])

    expect(await screen.findByText(/img_0142-1\.jpg/)).toBeInTheDocument()
    expect(screen.getByText(/IMG_0142 \(1\)\.JPG/)).toBeInTheDocument()
  })

  it('sets aside a file the bucket will not take, and keeps the rest', async () => {
    render(<TrainingPage />)
    await settleListing()

    choose([photo('one.jpg'), new File(['x'], 'notes.txt', { type: 'text/plain' })])

    expect(await screen.findByText(/1 file skipped/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Upload 1 file/ })).toBeInTheDocument()
  })

  it('offers to send only what the set is missing', async () => {
    // The resume case, which is the whole reason the page asks the bucket what
    // it holds: after an interruption you re-pick the same folder.
    listTrainingSet.mockResolvedValue(['a.jpg', 'b.jpg'])
    render(<TrainingPage />)
    await settleListing()

    choose([photo('a.jpg'), photo('b.jpg'), photo('c.jpg')])

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Upload 1 file/ })).toBeInTheDocument()
    })
    expect(screen.getAllByText('Already in the set')).toHaveLength(2)
  })

  it('sends the set name and the files to the uploader', async () => {
    render(<TrainingPage />)
    await settleListing()

    fireEvent.change(screen.getByLabelText('Set name'), { target: { value: 'My Cat LoRA' } })
    await settleListing()
    choose([photo('a.jpg')])

    fireEvent.click(await screen.findByRole('button', { name: /Upload 1 file/ }))

    await waitFor(() => expect(uploadTrainingSet).toHaveBeenCalled())
    const request = uploadTrainingSet.mock.calls[0]?.[0] as {
      setId: string
      files: { name: string }[]
    }
    // Corrected as it was typed: a set name with a space in it is refused by the
    // endpoint, and finding that out four hundred photos later would be a poor
    // way to be told.
    expect(request.setId).toBe('my-cat-lora')
    expect(request.files.map((file) => file.name)).toEqual(['a.jpg'])
  })

  it('reports the files that did not upload, and offers to retry only those', async () => {
    uploadTrainingSet.mockImplementation(
      (request: { files: { name: string }[]; onItem?: (p: unknown) => void }) => {
        for (const file of request.files) {
          request.onItem?.(
            file.name === 'b.jpg'
              ? { name: file.name, state: 'failed', error: 'R2 answered 500.' }
              : { name: file.name, state: 'done' },
          )
        }
        return Promise.resolve({ uploaded: 1, skipped: 0, failed: [{ name: 'b.jpg', error: 'x' }] })
      },
    )

    render(<TrainingPage />)
    await settleListing()
    choose([photo('a.jpg'), photo('b.jpg')])

    fireEvent.click(await screen.findByRole('button', { name: /Upload 2 files/ }))

    const retry = await screen.findByRole('button', { name: 'Retry failed' })
    fireEvent.click(retry)

    await waitFor(() => expect(uploadTrainingSet).toHaveBeenCalledTimes(2))
    const second = uploadTrainingSet.mock.calls[1]?.[0] as { files: { name: string }[] }
    // Only the one that failed: re-sending the file that worked would cost
    // another upload for nothing.
    expect(second.files.map((file) => file.name)).toEqual(['b.jpg'])
  })

  it('will not upload under a set name the endpoint would refuse', async () => {
    render(<TrainingPage />)
    await settleListing()
    choose([photo('a.jpg')])

    fireEvent.change(screen.getByLabelText('Set name'), { target: { value: '...' } })
    await settleListing()

    expect(await screen.findByRole('button', { name: /Upload 1 file/ })).toBeDisabled()
    expect(listTrainingSet).not.toHaveBeenCalledWith('', expect.anything())
  })
})
