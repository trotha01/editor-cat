/**
 * Publishing a finished export into Mintspace.
 *
 * Mintspace is a vertical video feed with its own Supabase project behind it —
 * a `videos` row per post, and the file itself in a public bucket. Both are
 * written straight from the browser under Mintspace's own row level security,
 * which is why there is no endpoint here and nothing server-side to configure:
 * the session doing the writing is the user's own Mintspace account, and the
 * rules that decide what it may write are the same ones the feed itself runs
 * under. Uploads land in `<uid>/…`, rows carry `user_id = auth.uid()`, and
 * anything else is refused by the database rather than by this file.
 *
 * The order matters and is not arbitrary. The file goes up first and the row
 * second, because a row is what makes a post appear: a row pointing at an
 * upload that failed is a broken card in everybody's feed, while an upload with
 * no row is an orphaned object nobody ever sees. Failing between the two is
 * therefore made to fail the harmless way round.
 */
import { mintspace, mintspaceSiteUrl, MINTSPACE_BUCKET } from './client'
import { newId } from '../media'

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
  /** The public URL of the uploaded file, which plays on its own. */
  videoUrl: string
  /** The object in the bucket, kept so the file can be deleted with the row. */
  storagePath: string
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
  /** The rendered MP4. */
  video: Blob
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
  const { video, caption, onStage } = request
  const client = mintspace()

  const account = await currentAccount()
  if (!account) {
    throw new Error('Sign in to Mintspace before publishing.')
  }

  const storage = client.storage.from(MINTSPACE_BUCKET)
  // Namespaced by account id, which is what Mintspace's storage policy checks:
  // the first folder segment has to be your own uid.
  const videoPath = `${account.id}/${newId('export')}.mp4`

  onStage?.('Uploading the video…')
  const { error: uploadError } = await storage.upload(videoPath, video, {
    contentType: 'video/mp4',
    upsert: false,
  })
  if (uploadError) throw uploadError

  const videoUrl = storage.getPublicUrl(videoPath).data.publicUrl

  onStage?.('Adding it to the feed…')
  const trimmed = caption.trim()
  // `poster_url` is left off entirely rather than sent as null: Mintspace shows
  // the video's own first frame when there is none, which is the whole of what
  // a poster would have bought here.
  const { data, error } = await client
    .from('videos')
    .insert({
      user_id: account.id,
      // Nullable on the row, and null is how Mintspace renders "no caption" —
      // an empty string would be a caption that happens to say nothing.
      caption: trimmed.length > 0 ? trimmed : null,
      video_url: videoUrl,
    })
    .select('id')
    .single()
  if (error) throw error

  return {
    id: String((data as { id?: unknown })?.id ?? ''),
    videoUrl,
    storagePath: videoPath,
    siteUrl: mintspaceSiteUrl(),
  }
}

/** What `deleteVideo` needs to find a post again and prove it may remove it. */
export interface DeletableVideo {
  videoId: string
  storagePath: string
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

  // `.select()` is what makes this answerable: without it a delete that matched
  // nothing looks exactly like one that matched a row.
  const { data, error } = await client.from('videos').delete().eq('id', video.videoId).select('id')
  if (error) throw error
  const rowDeleted = Array.isArray(data) && data.length > 0

  const { error: fileError } = await client.storage
    .from(MINTSPACE_BUCKET)
    .remove([video.storagePath])
  if (fileError) {
    // Worth reporting, not worth failing: the post is already out of the feed,
    // and the file left behind is unreachable without the row that named it.
    console.warn('Mintspace video row deleted, but its file remains', fileError)
  }

  return { rowDeleted, fileDeleted: !fileError }
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
