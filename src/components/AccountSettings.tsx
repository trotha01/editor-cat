/**
 * Who is signed in, and the way back out.
 *
 * Signing out is here rather than in the auth store's own callers because it has
 * to reach two stores at once, and the dependency only runs one way: the Drive
 * store already knows about auth, so auth must not learn about Drive. A
 * component is where the two legitimately meet.
 */
import { Button, Callout } from './ui'
import { requiresSignIn, useAuthStore } from '../state/useAuthStore'
import { useDriveStore } from '../state/useDriveStore'

export function AccountSettings() {
  const session = useAuthStore((state) => state.session)
  const signOut = useAuthStore((state) => state.signOut)
  const driveStatus = useDriveStore((state) => state.status)
  const durable = useDriveStore((state) => state.durable)

  // A build with no Supabase project behind it has no account to show, and the
  // editor is open to anyone who loads it.
  if (!requiresSignIn()) return null

  const leave = async () => {
    // Drive first: it is this browser's copy of someone's credentials, and it
    // must be gone whether or not the sign-out round trip succeeds.
    useDriveStore.getState().forget()
    await signOut()
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Account</p>
          <p className="truncate text-xs text-ink-dim">
            {session?.user.email ?? 'Signed in with Google'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => void leave()}>
          Sign out
        </Button>
      </div>

      {/* The one case where the Drive section below is not a mistake: this site
          cannot ask for Drive during sign-in, so it has to be granted on its
          own. Without saying so, that button looks like something that should
          have happened already. */}
      {durable === false && driveStatus !== 'unconfigured' ? (
        <Callout tone="info" title="Drive is a separate step on this site">
          Signing in normally grants Google Drive at the same time. This deployment is not set up
          for that, so Drive is allowed below instead — see <code>GOOGLE_CLIENT_SECRET</code> in the
          README.
        </Callout>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-dim">
        Signing out leaves your projects in your account and your media in Drive. What it clears is
        this browser: the Google permission held in memory, and the folder new media was being saved
        into.
      </p>
    </section>
  )
}
