/**
 * Who is signed in, and the way back out.
 *
 * Signing out used to have to reach two stores at once, because Drive held a
 * copy of someone's Google credentials that had to be cleared whether or not
 * the sign-out round trip succeeded. There is no Drive any more, so this is
 * back to being one call.
 */
import { Button } from './ui'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'

export function AccountSettings() {
  const account = useAuthStore((state) => state.account)
  const signOut = useAuthStore((state) => state.signOut)
  // A build with no Supabase project behind it has no account to show, and the
  // editor is open to anyone who loads it.
  if (!requiresSignIn()) return null

  const leave = async () => {
    await signOut()
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Account</p>
          <p className="truncate text-xs text-ink-dim">
            {account?.email || 'Signed in with Google'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => void leave()}>
          Sign out
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-ink-dim">
        Your projects and media stay where they are. Signing out only clears this browser.
      </p>
    </section>
  )
}
