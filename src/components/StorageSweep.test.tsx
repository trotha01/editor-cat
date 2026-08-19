import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

/**
 * The panel that removes stored files nothing points at.
 *
 * It is the only thing in the app that deletes media on purpose, so the two
 * behaviours worth pinning are both about consent: a failed check must never
 * present as "nothing to clean up", and the button must remove the set that was
 * on screen rather than a freshly computed one.
 */
const unusedFiles = vi.fn()
const sweepUnused = vi.fn()

vi.mock('../lib/r2/sweep', () => ({
  unusedFiles: () => unusedFiles() as unknown,
  sweepUnused: (found: unknown) => sweepUnused(found) as unknown,
}))

vi.mock('../lib/supabase/client', () => ({ isSupabaseConfigured: () => true }))
vi.mock('../lib/db', () => ({ formatBytes: (bytes: number) => `${bytes} B` }))

const { StorageSweep } = await import('./StorageSweep')

const FOUND = {
  assets: [{ id: 'a1', name: 'old-take.mp4', key: 'asset/hash/a1', bytes: 100 }],
  strayKeys: ['asset/hash/a_ghost'],
  bytes: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
  unusedFiles.mockResolvedValue(FOUND)
  sweepUnused.mockResolvedValue({ assets: 1, objects: 2, bytes: 100 })
})

async function check() {
  render(<StorageSweep />)
  fireEvent.click(screen.getByRole('button', { name: /check for unused files/i }))
  return await screen.findByRole('button', { name: /remove 2 files/i })
}

describe('checking', () => {
  it('names what it found and how much it would free, before offering to remove it', async () => {
    await check()

    expect(screen.getByText(/are not referenced by anything/i)).toBeInTheDocument()
    expect(screen.getByText(/100 B/)).toBeInTheDocument()
    expect(screen.getByText('old-take.mp4')).toBeInTheDocument()
  })

  it('says so when a file has no catalogue entry left at all', async () => {
    await check()
    expect(screen.getByText(/no catalogue entry left/i)).toBeInTheDocument()
  })

  it('reports a failed check rather than offering to remove nothing', async () => {
    // The one that matters. "Could not find out" and "nothing to clean up" are
    // the same empty screen, and only one of them is safe to act on.
    unusedFiles.mockRejectedValue(new Error('could not reach the project list'))

    render(<StorageSweep />)
    fireEvent.click(screen.getByRole('button', { name: /check for unused files/i }))

    expect(await screen.findByText(/could not reach the project list/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^remove/i })).not.toBeInTheDocument()
  })

  it('says plainly when everything is still referenced', async () => {
    unusedFiles.mockResolvedValue({ assets: [], strayKeys: [], bytes: 0 })

    render(<StorageSweep />)
    fireEvent.click(screen.getByRole('button', { name: /check for unused files/i }))

    expect(await screen.findByText(/nothing is unused/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^remove/i })).not.toBeInTheDocument()
  })
})

describe('removing', () => {
  it('removes exactly the set that was shown', async () => {
    const button = await check()
    fireEvent.click(button)

    await screen.findByText(/removed 2 files/i)
    // The same object, not a re-read: what was on screen is what was agreed to.
    expect(sweepUnused).toHaveBeenCalledWith(FOUND)
    expect(unusedFiles).toHaveBeenCalledTimes(1)
  })

  it('can be backed out of without removing anything', async () => {
    await check()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(sweepUnused).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /check for unused files/i })).toBeInTheDocument()
  })

  it('reports a failed removal', async () => {
    sweepUnused.mockRejectedValue(new Error('R2 refused that'))

    const button = await check()
    fireEvent.click(button)

    expect(await screen.findByText(/R2 refused that/)).toBeInTheDocument()
  })
})
