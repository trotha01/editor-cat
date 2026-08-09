import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sleep, toProxyPath } from './falClient'

describe('toProxyPath', () => {
  it('rewrites a queue URL onto our own proxy', () => {
    expect(toProxyPath('https://queue.fal.run/fal-ai/flux/requests/abc123/status')).toBe(
      '/api/fal/fal-ai/flux/requests/abc123/status',
    )
  })

  it('preserves the query string', () => {
    expect(toProxyPath('https://queue.fal.run/fal-ai/flux/requests/abc?logs=1')).toBe(
      '/api/fal/fal-ai/flux/requests/abc?logs=1',
    )
  })

  it('handles a nested model id without mangling the request path', () => {
    // fal's queue path uses only the first two segments of a nested model id,
    // which is exactly why we rewrite its URL instead of rebuilding one.
    expect(toProxyPath('https://queue.fal.run/fal-ai/kling-video/requests/xyz')).toBe(
      '/api/fal/fal-ai/kling-video/requests/xyz',
    )
  })

  it('handles an owner-scoped model id, which carries no fal-ai/ prefix', () => {
    // Seedance is published as `bytedance/...`, so nothing here may assume the
    // first segment is always `fal-ai`.
    expect(toProxyPath('https://queue.fal.run/bytedance/seedance-2.0/requests/xyz/status')).toBe(
      '/api/fal/bytedance/seedance-2.0/requests/xyz/status',
    )
  })

  it('falls back sanely for a relative or malformed value', () => {
    expect(toProxyPath('fal-ai/flux/requests/abc')).toBe('/api/fal/fal-ai/flux/requests/abc')
    expect(toProxyPath('/fal-ai/flux')).toBe('/api/fal/fal-ai/flux')
  })
})

/**
 * The one deliberate pause everything in this app waits on: the poll interval
 * here, and the backoff between transcription attempts in `scribe.ts`.
 *
 * Worth its own tests because both of its callers are loops that a person is
 * watching with a Cancel button in front of them, and the failure mode is not a
 * wrong answer — it is a button that appears to do nothing until the timer
 * happens to come round. On fake timers, so the suite does not wait out the
 * very delays it is asserting.
 */
describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits the whole delay out', async () => {
    const done = vi.fn()
    void sleep(1000).then(done)

    await vi.advanceTimersByTimeAsync(999)
    expect(done).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalled()
  })

  it('ends when Cancel is pressed, not when the timer comes round', async () => {
    const controller = new AbortController()
    const waiting = sleep(60_000, controller.signal).then(
      () => 'finished',
      (cause: unknown) => cause,
    )

    await vi.advanceTimersByTimeAsync(10)
    controller.abort()

    const cause = await waiting
    expect(cause).toBeInstanceOf(DOMException)
    expect((cause as DOMException).name).toBe('AbortError')
  })

  it('does not wait out a signal that had already been aborted', async () => {
    // No timers are advanced here, deliberately. `abort` has already fired by
    // the time this is called and will not fire again, so a signal that arrives
    // spent has to be noticed up front — miss it and the next poll of a job the
    // user cancelled a moment ago still costs the full interval.
    const controller = new AbortController()
    controller.abort()

    const cause = await sleep(60_000, controller.signal).then(
      () => 'finished',
      (reason: unknown) => reason,
    )
    expect((cause as DOMException).name).toBe('AbortError')
  })
})
