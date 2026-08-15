/**
 * Who else is on this shelf, and whose shelf is on screen.
 *
 * Two controls that belong together and are used apart: a picker in the header,
 * drawn only once there is more than one shelf to pick between, and a dialog
 * for handing your own shelf to somebody and taking it back.
 *
 * The dialog reads the share list when it opens rather than holding it in a
 * store. It is the only thing that shows the list, it is open for a few seconds
 * at a time, and the answer changes when somebody who is not looking at this
 * page signs in — so a cached copy would mostly be a way of showing a stale one.
 *
 * **Inviting somebody grants more than the shelf.** The wording in here says so
 * rather than leaving it in a schema comment: a share lets that account read the
 * stored files behind every take, on both sides, and it lets them spend this
 * deployment's generation budget the same way any signed-in visitor can. What it
 * does not touch is projects. See supabase/migrations/0012_shelf_shares.sql.
 */
import { useEffect, useState } from 'react'
import { Button, Callout, Field, Modal, Select, Spinner, TextInput } from './ui'
import {
  claimInvitations,
  inviteMember,
  leaveShelf,
  listShares,
  looksLikeEmail,
  revokeShare,
  sharesIssuedBy,
  type ShelfShare,
} from '../lib/supabase/shares'
import { toDisplayMessage } from '../lib/errors'
import { useAuthStore } from '../state/useAuthStore'
import { useWordsStore } from '../state/useWordsStore'

/**
 * Which shelf the page is showing.
 *
 * Absent entirely when there is only your own, which is the state almost every
 * account is in almost all of the time. A picker with one option in it is a
 * control that teaches somebody there is a choice and then refuses to let them
 * make one.
 */
export function ShelfPicker() {
  const shelves = useWordsStore((state) => state.shelves)
  const shelfOwnerId = useWordsStore((state) => state.shelfOwnerId)
  const switchShelf = useWordsStore((state) => state.switchShelf)

  if (shelves.length < 2) return null

  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-dim">
      <span className="sr-only">Shelf</span>
      <span aria-hidden>🗂️</span>
      <Select
        className="w-auto py-1 text-xs"
        value={shelfOwnerId ?? ''}
        onChange={(event) => void switchShelf(event.target.value)}
      >
        {shelves.map((shelf) => (
          <option key={shelf.ownerId} value={shelf.ownerId}>
            {shelf.mine ? 'My shelf' : shelfLabel(shelf.ownerId)}
          </option>
        ))}
      </Select>
    </label>
  )
}

/**
 * A shelf somebody else owns, named for a person rather than a subject.
 *
 * The subject is all this side has — `google-oauth2|104372…` — and it is nobody's
 * idea of a name. The share row that granted access carries the *invitee's*
 * address, which is this account's own, so it cannot help either. What is left is
 * the tail of the subject, which at least tells two shared shelves apart, and is
 * honest about being an identifier rather than dressing one up as a name.
 */
function shelfLabel(ownerId: string): string {
  return `Shared shelf ·${ownerId.slice(-6)}`
}

/**
 * The list, with any invitation for this account claimed on the way.
 *
 * Claimed here as well as on load because somebody can be invited while they
 * have this dialog open, and opening it is the most likely moment for them to
 * be looking for the invitation.
 */
async function readShares(): Promise<ShelfShare[]> {
  await claimInvitations()
  return await listShares()
}

/**
 * The dialog, which is a shell around a body that only exists while it is open.
 *
 * Split in two on purpose. The list has to be re-read every time the dialog
 * opens — somebody may have been invited, or have signed in and claimed an
 * invitation, since the last look — and the tidy way to express "start again" is
 * to mount something new rather than to reach in and blank three pieces of state
 * from an effect.
 */
export function SharingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Sharing this shelf">
      {open ? <SharingBody /> : null}
    </Modal>
  )
}

function SharingBody() {
  const account = useAuthStore((state) => state.account)
  const shelfOwnerId = useWordsStore((state) => state.shelfOwnerId)
  const loadShelves = useWordsStore((state) => state.loadShelves)

  const [shares, setShares] = useState<ShelfShare[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mine = account !== null && (shelfOwnerId === null || shelfOwnerId === account.id)

  /**
   * Reads the list and puts it on screen, reporting rather than throwing.
   *
   * Written with `then` rather than `await` so that nothing sets state until a
   * promise settles. This is called straight out of an effect on mount, and a
   * setState reachable synchronously from an effect body is a cascading render —
   * the same shape every other fetch-on-open in this app uses.
   */
  const refresh = (): Promise<void> =>
    readShares().then(
      (rows) => {
        setShares(rows)
        setError(null)
      },
      (cause: unknown) => setError(toDisplayMessage(cause)),
    )

  useEffect(() => {
    // Mounted afresh each time the dialog opens, so this runs exactly once per
    // opening and there is nothing to reset first.
    void refresh()
  }, [])

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await refresh()
      // The list of shelves this account can open may have just changed — a
      // shelf left, or an invitation claimed on the way in.
      await loadShelves()
    } catch (cause) {
      setError(toDisplayMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const invite = () => {
    const address = email.trim()
    if (!looksLikeEmail(address)) {
      setError(`"${address}" is not an email address.`)
      return
    }
    void act(async () => {
      await inviteMember(address)
      setEmail('')
    })
  }

  const issued = account && shares ? sharesIssuedBy(shares, account.id) : []
  const joined = account && shares ? shares.filter((share) => share.ownerId !== account.id) : []

  return (
    <div className="flex flex-col gap-5">
      {error ? <Callout tone="error">{error}</Callout> : null}

      {!mine ? (
        <Callout tone="info" title="You are on somebody else's shelf">
          Switch back to your own shelf to invite people to it. Anyone you invite is invited to the
          shelf you own, never to one you were let onto.
        </Callout>
      ) : null}

      <div className="flex flex-col gap-2">
        <Field
          label="Invite by email"
          htmlFor="shelf-share-email"
          hint={
            <>
              They sign in with Google exactly as you do, and your shelf appears alongside their
              own. Nothing is emailed to them from here — tell them it is waiting.
            </>
          }
        >
          <div className="flex gap-2">
            <TextInput
              id="shelf-share-email"
              type="email"
              autoComplete="off"
              placeholder="someone@example.com"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') invite()
              }}
            />
            <Button variant="primary" onClick={invite} disabled={busy || !email.trim()}>
              Invite
            </Button>
          </div>
        </Field>
      </div>

      <Callout tone="warn" title="What an invitation gives away">
        They can add, rename and delete anything on this shelf, and play and download every take on
        it. They can also reach the stored files behind your generated media, and spend this
        site&apos;s generation budget the same way you can. Your projects and timelines stay yours.
      </Callout>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
          People on your shelf
        </h3>
        {shares === null ? (
          <p className="flex items-center gap-2 text-sm text-ink-dim">
            <Spinner /> Reading who has been invited…
          </p>
        ) : issued.length === 0 ? (
          <p className="text-sm text-ink-dim">Nobody yet. Your shelf is yours alone.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {issued.map((share) => (
              <li
                key={share.memberEmail}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{share.memberEmail}</span>
                {/* An invitation nobody has signed in against yet is not a
                      share: there is no subject on the row, so no policy can
                      match it. Saying "invited" rather than showing it exactly
                      like the rest is what makes a mistyped address findable. */}
                <span className="shrink-0 text-xs text-ink-dim">
                  {share.memberId ? 'joined' : 'invited'}
                </span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void act(() => revokeShare(share.memberEmail))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {joined.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            Shelves shared with you
          </h3>
          <ul className="flex flex-col gap-1.5">
            {joined.map((share) => (
              <li
                key={share.ownerId}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{shelfLabel(share.ownerId)}</span>
                <Button
                  variant="ghost"
                  disabled={busy || share.memberId === null}
                  onClick={() => void act(() => leaveShelf(share.ownerId))}
                >
                  Leave
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
