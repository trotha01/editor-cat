import type { Config } from '@netlify/functions'
import { requireSession } from '../lib/auth'
import { jsonError } from '../lib/proxy'
import {
  type BucketKind,
  type R2Config,
  deleteKeys,
  listPrefix,
  presignGet,
  presignPut,
  r2Config,
} from '../lib/r2'
import {
  MAX_OBJECT_BYTES,
  MAX_OBJECTS_PER_REQUEST,
  MAX_REQUEST_BYTES,
  type Scope,
  assetPrefix,
  assetPrefixesFor,
  hashSubject,
  isAllowedContentType,
  isSafeId,
  isUnderAnyPrefix,
  isUnderPrefix,
  keysUnder,
  publicationPrefixFor,
} from '../lib/r2Keys'
import { mintspaceConfig, mintspaceUser } from '../lib/mintspaceToken'
import { shelfCounterparts } from '../lib/shelfShares'

/**
 * Minting URLs the browser uploads to and downloads from.
 *
 *   POST /api/r2/uploads    -> presigned PUTs for one publication or asset set
 *   POST /api/r2/downloads  -> presigned GETs, private bucket only
 *   POST /api/r2/deletes    -> remove one publication's objects
 *
 * **No bytes pass through here.** The browser PUTs straight to R2, which is what
 * keeps a sixty-megabyte export clear of the six-megabyte function payload
 * ceiling that shapes everything else in this directory. Nobody should later
 * "simplify" this by proxying the upload — it would cap the export size at a
 * fraction of a real video and reintroduce the ten-second timeout on the one
 * request most likely to be slow.
 *
 * The security model is one sentence: **every key is computed here from a
 * verified token, and no prefix is ever accepted from the client.** R2 has no
 * row-level security to fall back on — a presigned URL is simply valid — so
 * unlike the Supabase paths in this app, there is no database waiting to refuse
 * a write to somebody else's folder. r2Keys.ts holds the derivation and its
 * tests.
 *
 * Sharing a word shelf makes that sentence plural on the read path and nowhere
 * else. A caller may now be entitled to prefixes besides their own, but the
 * *set* is still derived here rather than sent: lib/shelfShares.ts asks the
 * database which subjects the caller shares a shelf with, and the prefixes are
 * hashed from those. Uploads are untouched — everything anyone writes still
 * lands under their own subject, whoever's shelf they are filing it into.
 *
 * Uploading a publication needs *both* identities: the Auth0 session that gates
 * every endpoint here, and a Mintspace session that decides whose prefix the
 * files belong under. mintspaceToken.ts explains why the second one is not
 * optional.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Every response here is per-user and half of them contain a credential.
      'cache-control': 'no-store',
    },
  })
}

function notConfigured(): Response {
  return jsonError(
    503,
    'This site is not set up for media storage.',
    'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_PUBLIC and ' +
      "R2_BUCKET_PRIVATE in the site's environment variables.",
  )
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringsIn(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null
}

/**
 * The Mintspace account publishing, from its own token.
 *
 * Sent as `x-mintspace-authorization` rather than `authorization`, which the
 * Auth0 session already occupies. Two identities, two headers — and naming the
 * second one explicitly is what stops a future reader assuming either token
 * would do.
 */
async function mintspaceAccount(
  request: Request,
): Promise<{ ok: true; uid: string } | { ok: false; response: Response }> {
  const config = mintspaceConfig()
  if (!config) {
    return {
      ok: false,
      response: jsonError(
        503,
        'This site is not set up for publishing.',
        'Set MINTSPACE_SUPABASE_URL (or its VITE_ form) in the site environment.',
      ),
    }
  }

  const header = request.headers.get('x-mintspace-authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) {
    return {
      ok: false,
      response: jsonError(401, 'Sign in to Mintspace before publishing.', 'No Mintspace token.'),
    }
  }

  let user
  try {
    user = await mintspaceUser(token, config)
  } catch (error) {
    // Mintspace's signing keys could not be fetched. Not the visitor's fault and
    // not fixed by signing in again, so it must not be reported as a rejected
    // token — that would send someone round a login that was never the problem.
    return {
      ok: false,
      response: jsonError(
        502,
        'Could not check your Mintspace sign-in just now.',
        error instanceof Error ? error.message : String(error),
      ),
    }
  }

  if (!user) {
    return {
      ok: false,
      response: jsonError(
        401,
        'That Mintspace sign-in could not be verified.',
        'Sign out of Mintspace and in again, then retry.',
      ),
    }
  }

  return { ok: true, uid: user.id }
}

interface RequestedObject {
  name: string
  contentType: string
  bytes: number
}

function parseObjects(value: unknown):
  | { ok: true; items: RequestedObject[] }
  | {
      ok: false
      reason: string
    } {
  if (!Array.isArray(value)) return { ok: false, reason: '"items" must be an array.' }
  if (value.length === 0) return { ok: false, reason: 'No objects were named.' }
  if (value.length > MAX_OBJECTS_PER_REQUEST) {
    return { ok: false, reason: `That is more than ${MAX_OBJECTS_PER_REQUEST} objects.` }
  }

  const items: RequestedObject[] = []
  let total = 0

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'Every item must be an object.' }
    }
    const record = entry as Record<string, unknown>
    const name = record.name
    const contentType = record.contentType
    const bytes = record.bytes

    if (typeof name !== 'string') return { ok: false, reason: 'Every item needs a "name".' }
    if (typeof contentType !== 'string') {
      return { ok: false, reason: `"${name}" has no content type.` }
    }
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return { ok: false, reason: `"${name}" has no usable size.` }
    }
    if (bytes > MAX_OBJECT_BYTES) {
      return { ok: false, reason: `"${name}" is larger than this site stores in one object.` }
    }

    total += bytes
    if (total > MAX_REQUEST_BYTES) {
      return { ok: false, reason: 'That upload is larger than this site accepts at once.' }
    }

    items.push({ name, contentType, bytes })
  }

  return { ok: true, items }
}

/**
 * Where this request is allowed to write, and to which bucket.
 *
 * The only place a scope becomes a prefix. Note that neither branch reads a
 * path, an id-of-somebody-else, or anything else from the body beyond a
 * publication id that is validated as a single safe segment.
 */
async function resolveTarget(
  request: Request,
  scope: Scope,
  payload: Record<string, unknown>,
  subject: string,
): Promise<{ ok: true; prefix: string; kind: BucketKind } | { ok: false; response: Response }> {
  if (scope === 'asset') {
    return { ok: true, prefix: assetPrefix(await hashSubject(subject)), kind: 'private' }
  }

  const account = await mintspaceAccount(request)
  if (!account.ok) return account

  const publicationId = payload.publicationId
  if (typeof publicationId !== 'string' || !isSafeId(publicationId)) {
    return { ok: false, response: jsonError(400, 'That publication id is not one we store under.') }
  }

  const prefix = publicationPrefixFor(account.uid, publicationId)
  if (!prefix.ok) return { ok: false, response: jsonError(400, prefix.reason) }

  return { ok: true, prefix: prefix.prefix, kind: 'public' }
}

function parseScope(value: unknown): Scope | null {
  return value === 'publication' || value === 'asset' ? value : null
}

async function uploads(request: Request, config: R2Config, subject: string): Promise<Response> {
  const payload = await body(request)
  if (!payload) return jsonError(400, 'That request could not be read.')

  const scope = parseScope(payload.scope)
  if (!scope) return jsonError(400, 'Unknown scope.', 'Expected "publication" or "asset".')

  const parsed = parseObjects(payload.items)
  if (!parsed.ok) return jsonError(400, 'That upload was refused.', parsed.reason)

  for (const item of parsed.items) {
    if (!isAllowedContentType(scope, item.contentType)) {
      // Enforced by the signature as well as here — see presignPut. A signed URL
      // whose content type were free would let this bucket host a web page on a
      // domain of ours.
      return jsonError(
        400,
        'That kind of file is not stored here.',
        `"${item.name}" is ${item.contentType}.`,
      )
    }
  }

  const target = await resolveTarget(request, scope, payload, subject)
  if (!target.ok) return target.response

  const keys = keysUnder(
    target.prefix,
    parsed.items.map((item) => item.name),
  )
  if (!keys.ok) return jsonError(400, 'That upload was refused.', keys.reason)

  const urls = await Promise.all(
    parsed.items.map(async (item, index) => ({
      name: item.name,
      key: keys.keys[index] as string,
      url: await presignPut(config, target.kind, keys.keys[index] as string, {
        contentType: item.contentType,
      }),
    })),
  )

  return json({ prefix: target.prefix, bucket: target.kind, urls })
}

/**
 * The Auth0 ID token, when the browser sent one.
 *
 * A second identity in a header of its own, exactly as publishing does with
 * Mintspace's — and for a related reason: this one is not interchangeable with
 * the `authorization` token either. That is the access token, minted for this
 * site's API; this is the ID token, which is what Supabase accepts. Only used to
 * ask the database who the caller shares a shelf with, and only after its
 * subject has been checked against the verified one. See lib/shelfShares.ts.
 */
function supabaseIdToken(request: Request): string | null {
  const header = request.headers.get('x-supabase-authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return null
  return header.slice(7).trim() || null
}

/**
 * Presigned GETs for objects the caller may read.
 *
 * Private bucket only, by construction: the public one is served from a custom
 * domain and needs no signature at all, so a signed URL for it would be a
 * pointless credential to hand out.
 *
 * Their own files are the whole of it until a word shelf is shared, and that
 * case still costs nothing: keys under the caller's own prefix are settled
 * without asking anybody. Only a key that is *not* theirs sends this looking,
 * which is what keeps the ordinary hydration of an ordinary project exactly the
 * request it was before shares existed.
 */
async function downloads(request: Request, config: R2Config, subject: string): Promise<Response> {
  const payload = await body(request)
  if (!payload) return jsonError(400, 'That request could not be read.')

  const keys = stringsIn(payload.keys)
  if (!keys) return jsonError(400, '"keys" must be an array of strings.')
  if (keys.length === 0) return jsonError(400, 'No keys were named.')
  if (keys.length > MAX_OBJECTS_PER_REQUEST) {
    return jsonError(400, `That is more than ${MAX_OBJECTS_PER_REQUEST} keys.`)
  }

  // The client names keys here because it is echoing back what an upload
  // returned. Checked against the prefixes we would have derived anyway, so a
  // guessed key belonging to someone else is refused rather than signed.
  const own = assetPrefix(await hashSubject(subject))
  const foreign = keys.filter((key) => !isUnderPrefix(key, own))

  if (foreign.length > 0) {
    const shared = await shelfCounterparts(subject, supabaseIdToken(request))

    // Not a 403. The question of whether these files are the caller's to read
    // was never answered, and telling somebody their collaborator's takes do not
    // belong to them — when the truth is that a lookup failed — sends them to
    // undo a share that was working.
    if (shared.degraded) {
      return jsonError(502, 'Could not check which shelves you are on just now.', shared.reason)
    }

    const allowed = [own, ...(await assetPrefixesFor(shared.subjects))]
    for (const key of foreign) {
      if (!isUnderAnyPrefix(key, allowed)) {
        return jsonError(403, 'That file does not belong to a shelf you are on.')
      }
    }
  }

  const urls = await Promise.all(
    keys.map(async (key) => ({ key, url: await presignGet(config, 'private', key) })),
  )

  return json({ urls })
}

async function deletes(request: Request, config: R2Config, subject: string): Promise<Response> {
  const payload = await body(request)
  if (!payload) return jsonError(400, 'That request could not be read.')

  const scope = parseScope(payload.scope)
  if (!scope) return jsonError(400, 'Unknown scope.', 'Expected "publication" or "asset".')

  const target = await resolveTarget(request, scope, payload, subject)
  if (!target.ok) return target.response

  // Named keys are the usual path: a publication records exactly what it wrote,
  // so teardown is a known-length batch and never has to ask the bucket. The
  // listing below is the backstop for records written before that was kept.
  const named = stringsIn(payload.keys)
  let keys: string[]

  if (named && named.length > 0) {
    for (const key of named) {
      if (!isUnderPrefix(key, target.prefix)) {
        return jsonError(403, 'That file does not belong to this account.')
      }
    }
    keys = named
  } else {
    try {
      keys = await listPrefix(config, target.kind, target.prefix)
    } catch (error) {
      return jsonError(
        502,
        'Could not work out what to remove.',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (keys.length > MAX_OBJECTS_PER_REQUEST) {
    // The ten-second function budget is the real limit here. Better to say so
    // than to time out halfway and leave the caller unsure what happened.
    return jsonError(400, 'That is more objects than can be removed in one request.')
  }

  const outcome = await deleteKeys(config, target.kind, keys)
  return json({ deleted: outcome.deleted.length, failed: outcome.failed })
}

export default async (request: Request): Promise<Response> => {
  const route = new URL(request.url).pathname.replace(/^\/api\/r2\/?/, '').replace(/\/+$/, '')

  if (request.method !== 'POST') return jsonError(405, 'Use POST.')

  const session = await requireSession(request)
  if (!session.ok) return session.response

  const config = r2Config()
  if (!config) return notConfigured()

  // `userId` is null only where the deployment has opted into anonymous access
  // for local development, where there is exactly one person; a fixed string
  // keeps their files in one namespace rather than scattering them.
  const subject = session.userId ?? 'anonymous'

  if (route === 'uploads') return await uploads(request, config, subject)
  if (route === 'downloads') return await downloads(request, config, subject)
  if (route === 'deletes') return await deletes(request, config, subject)

  return jsonError(404, 'No such endpoint.')
}

export const config: Config = {
  path: '/api/r2/*',
}
