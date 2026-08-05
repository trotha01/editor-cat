import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScheduler } from './scheduler'

/** A promise plus the handles to settle it from the test. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((fn) => {
    resolve = fn
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createScheduler', () => {
  it('waits for the quiet period before running', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 2000)

    scheduler.schedule()
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of edits into one run', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 2000)

    // Typing in the project name field looks exactly like this.
    scheduler.schedule()
    await vi.advanceTimersByTimeAsync(500)
    scheduler.schedule()
    await vi.advanceTimersByTimeAsync(500)
    scheduler.schedule()

    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never runs two at once', async () => {
    const first = deferred()
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 1000)

    scheduler.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)

    // A second trigger while the first is still in flight must not start a
    // parallel write — two concurrent writes race the version guard, and the
    // loser reports a conflict that is really self-inflicted.
    scheduler.schedule()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)

    first.resolve()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('re-runs for an edit made during a run, rather than losing it', async () => {
    const first = deferred()
    const run = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 1000)

    scheduler.schedule()
    await vi.advanceTimersByTimeAsync(1000)

    // The edit that arrives mid-save is the one most easily dropped, and its
    // loss shows up only as "my last change sometimes vanished".
    scheduler.schedule()
    first.resolve()
    await vi.runAllTimersAsync()

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('flush runs immediately without waiting out the quiet period', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 5000)

    scheduler.schedule()
    await scheduler.flush()

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('flush does not leave the scheduled run to fire again afterwards', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 5000)

    scheduler.schedule()
    await scheduler.flush()
    await vi.runAllTimersAsync()

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cancel drops a pending run', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 1000)

    scheduler.schedule()
    scheduler.cancel()
    await vi.runAllTimersAsync()

    expect(run).not.toHaveBeenCalled()
    expect(scheduler.pending()).toBe(false)
  })

  it('keeps working after a run throws, without an escaping rejection', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    const scheduler = createScheduler(run, 1000)

    scheduler.schedule()
    // No `.catch` here on purpose: the scheduler fires from a timer, so a
    // rejection it lets escape becomes an unhandled rejection on every failed
    // save. Vitest fails the run if one appears.
    await vi.advanceTimersByTimeAsync(1000)

    // A failed push must also not wedge the scheduler: the next edit still saves.
    scheduler.schedule()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('flush resolves rather than rejecting when the run fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('offline'))
    const scheduler = createScheduler(run, 1000)

    // `flush` runs from pagehide handlers, which cannot handle a rejection.
    await expect(scheduler.flush()).resolves.toBeUndefined()
  })
})
