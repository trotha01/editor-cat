/**
 * Runs tasks a few at a time.
 *
 * Both callers pull from remote services that throttle per user: Drive rejects
 * a wide fan-out of folder listings, and hydration would otherwise start every
 * media download at once and starve them all of bandwidth.
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item, index)
    }
  })

  await Promise.all(workers)
  return results
}
