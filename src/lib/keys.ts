/**
 * What is left of bring-your-own-key: taking the last one back out again.
 *
 * Two provider keys were typed into this app in its time. fal went first, when
 * generation moved onto the deployment's own account; ElevenLabs has now
 * followed it, so nothing in the browser holds a provider credential at all and
 * there is no field left to type one into.
 *
 * That leaves the copies already written to local storage on the devices of
 * everyone who ticked "remember on this device". They are live credentials that
 * nothing will ever read again, and a key nobody can see is a key nobody
 * rotates — so the app deletes them on the way past rather than leaving them to
 * sit there.
 *
 * This module is expected to become deletable. It is worth one release of
 * keeping, because "we stopped reading it" and "it is gone" are different
 * promises, and only one of them is worth making to somebody about their key.
 */

const STORAGE_KEYS = ['editor-cat.keys.v1', 'editor-cat.keys.remember.v1']

function safeLocalStorage(): Storage | null {
  try {
    // Access can throw in private-browsing modes and sandboxed frames.
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Erases any provider key this app used to store, and says whether it found
 * one — which the caller has no use for beyond a test, and a test is exactly
 * what a deletion nobody can see needs.
 */
export function purgeStoredKeys(): boolean {
  const store = safeLocalStorage()
  if (!store) return false

  let found = false
  for (const key of STORAGE_KEYS) {
    if (store.getItem(key) !== null) found = true
    store.removeItem(key)
  }
  return found
}
