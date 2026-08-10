/**
 * Authorising Google Drive.
 *
 * This used to be sign-in as well. One OAuth request asked for identity and
 * Drive together and came back with an ID token *and* a consent code, so a
 * single screen covered both. Netlify Identity owns sign-in now, and an Identity
 * login returns proof of who someone is and nothing else — there is no scope to
 * add on the way past. So Drive is asked for on its own, in the step
 * immediately after signing in.
 *
 * The cost of splitting them is one extra screen, and `loginHint` is what keeps
 * it to that: the account is already known from the Identity session, so Google
 * goes straight to the consent rather than asking which account first.
 *
 * A pop-up rather than a redirect, unlike the Identity login: this one can be
 * reached from Settings with a project open, and reconnecting Drive must not
 * navigate away mid-edit.
 */
import { clientId, DRIVE_SCOPES } from './gis'
import { requestAuthorization } from './oauthPopup'

/**
 * Opens Google's consent screen for Drive and returns the code it hands back.
 *
 * The code is one-time and useless without the client secret, which only the
 * Netlify function has — so it travels straight there to be exchanged for a
 * refresh token. See connection.ts.
 *
 * Must be called straight from a click, or the pop-up is blocked.
 *
 * @param email The signed-in address, offered to Google as a hint so the user is
 *   not asked to choose an account they have already chosen.
 */
export async function requestDriveAuthorization(email?: string): Promise<string> {
  const id = clientId()
  if (!id) {
    throw new Error(
      'Google Drive is not configured for this site: VITE_GOOGLE_CLIENT_ID is not set.',
    )
  }

  const result = await requestAuthorization({
    clientId: id,
    scope: DRIVE_SCOPES,
    // `consent` because Google only issues a refresh token alongside a fresh
    // grant — without it a returning user would connect successfully and find
    // themselves disconnected an hour later.
    prompt: 'consent',
    ...(email ? { loginHint: email } : {}),
  })

  return result.code
}
