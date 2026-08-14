/**
 * Publishing a finished export into Mintspace.
 *
 * Mintspace is a vertical video feed with its own Supabase project behind it: a
 * `videos` row per post. The row is written straight from the browser under
 * Mintspace's own row level security — the session doing the writing is the
 * user's own Mintspace account, and the rules that decide what it may write are
 * the same ones the feed itself runs under, so `user_id = auth.uid()` and
 * anything else is refused by the database rather than by this file.
 *
 * The *video* no longer goes to Mintspace's storage bucket. It goes to
 * Cloudflare R2, behind a CDN, as an HLS package: a playlist, an init segment
 * and a segment every few seconds. R2 charges nothing for egress, which is the
 * whole reason — a feed is a place where the same file is fetched over and over
 * by people who did not ask for it by name. (Cloudflare Stream would do this
 * too and is not used: its per-delivered-minute price is around a hundred times
 * R2's at any view volume worth having.)
 *
 * That split means publishing now needs *both* identities. Auth0 says you may
 * spend this deployment's storage at all; the Mintspace session says whose
 * prefix the files belong under, and it has to be that one — the feed row is
 * owned by the Mintspace uid, and keying the objects by the Auth0 subject
 * instead is what would let a later delete remove the row, derive a different
 * prefix, find nothing, and report success. See netlify/lib/mintspaceToken.ts.
 *
 * The order matters and is not arbitrary, at both levels. Files go up before
 * the row, because a row is what makes a post appear: a row pointing at an
 * upload that failed is a broken card in everybody's feed, while an upload with
 * no row is an orphaned object nobody ever sees. And *within* the upload,
 * segments and poster go before the playlist, because a playlist that exists
 * has to imply its segments exist — publishing it first and losing a segment
 * gives a card that spins forever, which is strictly worse than an invisible
 * orphan. Failing anywhere is made to fail the harmless way round.
 */
import { mintspace, mintspaceSiteUrl } from './client'
import { newId } from '../media'
import { deletePublication, uploadFiles, type UploadFile } from '../r2/upload'
import { publicUrl } from '../r2/client'
import { contentTypeFor, PLAYLIST_NAME, POSTER_NAME } from '../export/hlsArgs'
import type { HlsPackage } from '../export/render'

/** Matches the `char_length(caption) <= 300` check on mintspace.videos. */
export const CAPTION_MAX_LENGTH = 300

export interface MintspaceAccount {
  id: string
  email: string | null
  /** The handle the post will appear under, as `profiles.username` holds it. */
  username: string
}

export interface PublishedVideo {
  id: string
  /** The id the prefix was built from, needed again to take it down. */
  publicationId: string
  /** The public URL of the playlist, which is what the feed row points at. */
  videoUrl: string
  posterUrl: string | null
  /** The prefix everything landed under. */
  prefix: string
  /** Every object written, so teardown never has to ask the bucket. */
  keys: string[]
  /** Where to send someone to see it in the feed, if this build knows. */
  siteUrl: string
}

/**
 * The account a Mintspace session belongs to, or null when there is none.
 *
 * `ensure_profile()` rather than a select on `profiles`: Mintspace hands out
 * profiles from a trigger on sign-up, but an account that reached the project
 * through a sibling app — which, from Mintspace's side, is exactly what this
 * editor is — may never have fired it. The function is the seam Mintspace
 * provides for precisely that case, and it is idempotent, so asking costs one
 * round trip and settles the question for good.
 */
export async function currentAccount(): Promise<MintspaceAccount | null> {
  const client = mintspace()
  const { data } = await client.auth.getSession()
  const session = data.session
  if (!session) return null

  const { data: profile, error } = await client.rpc('ensure_profile')
  if (error) throw error

  const row = (Array.isArray(profile) ? profile[0] : profile) as { username?: unknown } | null
  return {
    id: session.user.id,
    email: session.user.email ?? null,
    // A profile that somehow came back without one still leaves the caller with
    // something to print; it does not change who the post belongs to.
    username: typeof row?.username === 'string' ? row.username : 'you',
  }
}

export async function signIn(email: string, password: string): Promise<MintspaceAccount> {
  const { error } = await mintspace().auth.signInWithPassword({ email, password })
  if (error) throw error

  const account = await currentAccount()
  if (!account) throw new Error('Signed in, but no Mintspace session came back.')
  return account
}

export interface SignUpResult {
  /** True when Supabase sent a confirmation email instead of a session. */
  needsConfirmation: boolean
  account: MintspaceAccount | null
}

export async function signUp(
  email: string,
  password: string,
  username: string,
): Promise<SignUpResult> {
  const { data, error } = await mintspace().auth.signUp({
    email,
    password,
    // Mintspace's handle_new_user() trigger reads this to name the profile it
    // creates. It sanitises whatever arrives and falls back to the address, so
    // a handle that would not satisfy the column's own check constraint is
    // squeezed into shape there rather than rejected here.
    options: { data: { username } },
  })
  if (error) throw error

  if (!data.session) return { needsConfirmation: true, account: null }
  return { needsConfirmation: false, account: await currentAccount() }
}

export async function signOut(): Promise<void> {
  const { error } = await mintspace().auth.signOut()
  if (error) throw error
}

export interface PublishRequest {
  /** The streaming package: segments, init segment, playlist — in upload order. */
  hls: HlsPackage
  /** The first frame, if one was extracted. */
  poster?: Blob
  caption: string
  onStage?: (stage: string) => void
}

/**
 * Uploads the file and adds the row that puts it in the feed.
 *
 * Any failure after the upload leaves the object behind. Deleting it on the way
 * out would need the failure to be reported *and* the cleanup to succeed, and
 * the case where that matters — a caption the database refused — is one the
 * user is about to retry anyway, at which point the second upload is the one
 * the row points at. An orphan in a private folder is the cheapest thing here
 * to get wrong.
 */
export async function publishVideo(request: PublishRequest): Promise<PublishedVideo> {
  const { hls, poster, caption, onStage } = request
  const client = mintspace()

  const account = await currentAccount()
  if (!account) {
    throw new Error('Sign in to Mintspace before publishing.')
  }

  // The Mintspace session's own access token, which /api/r2 verifies to work
  // out whose prefix these files belong under. Sent rather than the Auth0 one
  // because the *feed row* is owned by this account, and keying the objects by
  // the other identity is what would let a delete report success over files it
  // never found. See netlify/lib/mintspaceToken.ts.
  const { data: session } = await client.auth.getSession()
  const mintspaceToken = session.session?.access_token ?? null
  if (!mintspaceToken) throw new Error('Sign in to Mintspace before publishing.')

  // Fresh every time, never reused on a retry: these objects are served with a
  // year-long cache, so a prefix that once held a failed attempt would keep
  // serving it from the edge long after it was replaced.
  const publicationId = newId('export')

  const files: UploadFile[] = hls.files.map((file) => ({
    name: file.name,
    blob: file.blob,
    contentType: file.contentType,
  }))

  // The poster goes *before* the playlist, for the same reason the segments do:
  // once the playlist exists the row can be written, and a row whose poster is
  // still uploading is a card with a blank frame.
  if (poster) {
    files.splice(files.length - 1, 0, {
      name: POSTER_NAME,
      blob: poster,
      contentType: contentTypeFor(POSTER_NAME),
    })
  }

  onStage?.('Uploading the video…')
  const uploaded = await uploadFiles({
    scope: 'publication',
    publicationId,
    mintspaceToken,
    files,
    onProgress: (done, total) => onStage?.(`Uploading the video… ${done}/${total}`),
  })

  const keyFor = new Map(uploaded.objects.map((object) => [object.name, object.key]))
  const playlistKey = keyFor.get(PLAYLIST_NAME)
  if (!playlistKey) throw new Error('The playlist did not finish uploading.')

  const videoUrl = publicUrl(playlistKey)
  const posterKey = poster ? keyFor.get(POSTER_NAME) : undefined
  const posterUrl = posterKey ? publicUrl(posterKey) : null

  onStage?.('Adding it to the feed…')
  const trimmed = caption.trim()
  // `poster_url` is sent now, where it used to be left off. Dropping the
  // progressive MP4 is what changed: `preload="metadata"` no longer paints a
  // first frame while the manifest is being fetched, so a feed of HLS cards
  // with no posters is a feed of black rectangles for the first moment of every
  // scroll. Still omitted rather than nulled when there is none — Mintspace
  // falls back to the video's own first decoded frame.
  const { data, error } = await client
    .from('videos')
    .insert({
      user_id: account.id,
      // Nullable on the row, and null is how Mintspace renders "no caption" —
      // an empty string would be a caption that happens to say nothing.
      caption: trimmed.length > 0 ? trimmed : null,
      video_url: videoUrl,
      ...(posterUrl ? { poster_url: posterUrl } : {}),
      // Where the bytes live, on the row rather than only in the project
      // document. This is the only authoritative record of what is still
      // referenced: Mintspace's own retention purge deletes rows without
      // touching storage, and it has no credentials to clean up with, so
      // without this a purged video's objects become unenumerable garbage.
      storage_prefix: uploaded.prefix,
    })
    .select('id')
    .single()
  if (error) throw error

  return {
    id: String((data as { id?: unknown })?.id ?? ''),
    publicationId,
    videoUrl,
    posterUrl,
    prefix: uploaded.prefix,
    keys: uploaded.objects.map((object) => object.key),
    siteUrl: mintspaceSiteUrl(),
  }
}

/** What `deleteVideo` needs to find a post again and prove it may remove it. */
export interface DeletableVideo {
  videoId: string
  /** The id the prefix was built from. */
  publicationId: string
  /** Every object to remove, as the publish recorded them. */
  r2Keys: string[]
  /** The account that published it; nobody else's session can delete it. */
  accountId: string
}

export interface DeleteOutcome {
  /**
   * False when the row had already gone — deleted from Mintspace itself, or by
   * another machine. Not a failure: the post is not in the feed either way, and
   * the caller stops tracking it regardless.
   */
  rowDeleted: boolean
  /** False when the row went but its file did not. Leaves an unseen orphan. */
  fileDeleted: boolean
}

/**
 * Takes a published video down: the row first, then the file.
 *
 * That order is the mirror of publishing, and for the same reason. The row is
 * what puts a card in the feed, so removing it is what actually takes the post
 * down; a file deleted first would leave the card up with nothing behind it,
 * playing nothing, for however long the rest takes. Failing in between leaves
 * an orphaned object nobody can reach — the harmless way round.
 *
 * The account check is done here rather than left to row-level security because
 * of how that failure arrives: a delete refused by RLS is not an error, it is
 * zero rows affected, and reporting "done" for a video still sitting in the
 * feed is the one outcome worth ruling out.
 */
export async function deleteVideo(video: DeletableVideo): Promise<DeleteOutcome> {
  const client = mintspace()

  const account = await currentAccount()
  if (!account) throw new Error('Sign in to Mintspace to delete this video.')
  if (account.id !== video.accountId) {
    throw new Error(
      'This video was published from a different Mintspace account. Sign in as that account to delete it.',
    )
  }

  const { data: session } = await client.auth.getSession()
  const mintspaceToken = session.session?.access_token ?? null

  // `.select()` is what makes this answerable: without it a delete that matched
  // nothing looks exactly like one that matched a row.
  const { data, error } = await client.from('videos').delete().eq('id', video.videoId).select('id')
  if (error) throw error
  const rowDeleted = Array.isArray(data) && data.length > 0

  // Within the prefix the order is irrelevant — nothing references any of it
  // once the row is gone. Driven from the recorded keys rather than a listing,
  // so this is a known-length batch that cannot half-finish against a query
  // that timed out.
  // Deliberately uninitialised: both paths below must decide, and a default
  // would let a branch added later fall through to a value nobody chose.
  let fileDeleted: boolean
  try {
    const outcome = await deletePublication({
      publicationId: video.publicationId,
      keys: video.r2Keys,
      mintspaceToken,
    })
    fileDeleted = outcome.failed.length === 0
    if (!fileDeleted) {
      console.warn('Mintspace video row deleted, but some files remain', outcome.failed)
    }
  } catch (cause) {
    // Worth reporting, not worth failing: the post is already out of the feed,
    // and the files left behind are unreachable without the row that named them.
    console.warn('Mintspace video row deleted, but its files remain', cause)
    fileDeleted = false
  }

  return { rowDeleted, fileDeleted }
}

/**
 * Turns whatever Supabase threw into a sentence worth showing.
 *
 * Three of these are setup rather than user error, and they are the ones whose
 * raw form says least: a project that never ran Mintspace's schema.sql, one
 * that ran it but did not expose the schema, and a bucket that filled its size
 * limit. Each has a specific next step, and none of them is "try again".
 */
export function mintspaceErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object') return fallback

  const record = error as { code?: unknown; message?: unknown; statusCode?: unknown }
  const code = typeof record.code === 'string' ? record.code : ''
  const message = typeof record.message === 'string' ? record.message : ''

  // The two ways a correctly built request still fails against a project that
  // was not finished being set up. Mintspace's own client explains these the
  // same way; the words are worth keeping close.
  if (code === 'PGRST106') {
    return 'The Mintspace project does not expose its "mintspace" schema to the API. Whoever set it up needs to add it under Project Settings → API → Exposed schemas.'
  }
  if (code === '42P01') {
    return 'The Mintspace tables do not exist in that project yet. Whoever set it up needs to run supabase/schema.sql against it.'
  }
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'Mintspace refused the post as coming from someone else. Sign out and in again, then retry.'
  }
  if (code === '23514') {
    return `Mintspace rejected the caption. Keep it to ${CAPTION_MAX_LENGTH} characters or fewer.`
  }

  // Storage, which answers in prose rather than in codes.
  if (/exceeded the maximum allowed size|payload too large/i.test(message) || code === '413') {
    return 'The file is larger than the Mintspace bucket accepts (100 MB by default). Export at a lower resolution or quality and publish that.'
  }
  if (/mime type/i.test(message)) {
    return 'The Mintspace bucket does not accept this kind of file. Whoever set it up needs to re-run supabase/schema.sql against that project.'
  }

  // Auth, where the codes are stable and the raw messages are nearly fine.
  if (code === 'invalid_credentials')
    return 'That email and password did not match a Mintspace account.'
  if (code === 'email_not_confirmed') {
    return 'That account still has to confirm its email address. Open the link Mintspace sent, then sign in.'
  }
  if (code === 'user_already_exists') {
    return 'There is already a Mintspace account with that address. Sign in instead.'
  }
  if (code === 'weak_password') {
    return 'That password is too short for Mintspace. Six characters or more.'
  }
  if (code === 'over_email_send_rate_limit') {
    return 'Mintspace is rate limiting sign-up emails to that address. Wait a minute and try again.'
  }

  // A fetch that never reached anybody rejects with a TypeError, whose message
  // ("Failed to fetch") names neither side of the conversation.
  if (error instanceof TypeError) {
    return 'Could not reach Mintspace. Check the connection and try again.'
  }

  return message || fallback
}
