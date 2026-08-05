/**
 * Debounced write scheduling.
 *
 * Pure and free of both React and Supabase so the awkward case can be tested
 * directly: an edit made *while* a save is in flight must not be swallowed.
 * Dropping that edit is the kind of bug that only shows up as "my last change
 * vanished sometimes", which is close to undebuggable after the fact.
 */

export interface Scheduler {
  /** Requests a run after the quiet period, restarting the clock. */
  schedule: () => void
  /** Runs now and resolves when the work — including any follow-up — is done. */
  flush: () => Promise<void>
  /** Drops a pending run. Work already in flight still finishes. */
  cancel: () => void
  /** True while a run is queued or executing. */
  pending: () => boolean
}

export function createScheduler(run: () => Promise<void>, delayMs: number): Scheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  /** Set when a run is requested while one is already executing. */
  let again = false

  const clearTimer = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const fire = (): Promise<void> => {
    clearTimer()

    // Never two at once: a second concurrent write would race the first for the
    // version guard and lose, reporting a conflict that is really our own doing.
    if (running) {
      again = true
      return running
    }

    running = (async () => {
      try {
        await run()
      } catch {
        // Swallowed on purpose. `run` owns its own error reporting — it sets
        // the sync status the user sees — and this is called from fire-and-
        // forget timers, where an escaping rejection becomes an unhandled
        // rejection on every failed save.
      } finally {
        running = null
      }
    })()

    return running.then(async () => {
      if (!again) return
      again = false
      await fire()
    })
  }

  const schedule = () => {
    clearTimer()
    timer = setTimeout(() => void fire(), delayMs)
  }

  return {
    schedule,
    flush: async () => {
      await fire()
    },
    cancel: clearTimer,
    pending: () => timer !== null || running !== null,
  }
}
