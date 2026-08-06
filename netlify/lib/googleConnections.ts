/**
 * Where a user's Google refresh token is kept.
 *
 * Reached over PostgREST with the service role key rather than through
 * `@supabase/supabase-js`. Three calls do not justify pulling the client library
 * into every function bundle, and the rest of `netlify/lib/` already talks to
 * Supabase over plain `fetch` for the same reason.
 *
 * The service role bypasses row-level security, which is the entire point: the
 * `google_connections` table has RLS on and no policies, so a browser holding a
 * user's own anon-key token still reads nothing from it. See
 * `supabase/migrations/0002_google_connections.sql`.
 */
import { supabaseProjectUrl } from './supabase'

const TABLE = 'google_connections'

export interface StoreConfig {
  url: string
  serviceKey: string
}

/**
 * The credentials for reaching the table, or null when this deployment has not
 * been set up for durable connections.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is the only genuinely new secret this feature
 * needs. It is deliberately not derived from anything the browser has: the anon
 * key cannot read this table, and that is what makes storing a refresh token
 * here defensible in the first place.
 *
 * The *URL* is a different matter, and is resolved by `supabaseProjectUrl` — the
 * same call `auth.ts` makes, so the two cannot disagree about whether this
 * deployment has a project behind it.
 */
export function storeConfig(): StoreConfig | null {
  const url = supabaseProjectUrl()
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!url || !serviceKey) return null
  return { url, serviceKey }
}

export interface StoredConnection {
  refreshToken: string
  scope: string
}

interface ConnectionRow {
  refresh_token?: string
  scope?: string
}

function headers(config: StoreConfig, extra: Record<string, string> = {}): Headers {
  return new Headers({
    apikey: config.serviceKey,
    authorization: `Bearer ${config.serviceKey}`,
    'content-type': 'application/json',
    ...extra,
  })
}

function endpoint(config: StoreConfig, query = ''): string {
  return `${config.url}/rest/v1/${TABLE}${query}`
}

/**
 * Raised when the table is not in the database at all.
 *
 * Worth its own type because it is the one storage failure an operator can act
 * on, and because it is otherwise indistinguishable from Supabase having a
 * moment. Telling the two apart is the difference between a site that says "run
 * the migration" and one that says "not set up for sign-in" — the second sends
 * whoever deployed it to re-check environment variables that were fine.
 */
export class MissingTableError extends Error {
  constructor(detail: string) {
    super(`The ${TABLE} table is not there. ${detail}`)
    this.name = 'MissingTableError'
  }
}

/**
 * The two ways "no such table" arrives: Postgres' own `undefined_table`, and
 * PostgREST's schema-cache miss — which is also what a table looks like in the
 * seconds after it is created, and when it exists but is not exposed.
 */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205'])

/** Turns a PostgREST failure into something a log line can be read from. */
async function failed(action: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Body already consumed or unreadable; the status still says enough.
  }

  let code: unknown
  try {
    code = (JSON.parse(detail) as { code?: unknown }).code
  } catch {
    // Not JSON: something between here and PostgREST answered instead. The
    // generic error below is the right reading of that.
  }
  if (typeof code === 'string' && MISSING_TABLE_CODES.has(code)) {
    return new MissingTableError(detail)
  }

  return new Error(`Could not ${action} the Google connection (${response.status}). ${detail}`)
}

export async function readConnection(
  userId: string,
  config: StoreConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredConnection | null> {
  const query = `?user_id=eq.${encodeURIComponent(userId)}&select=refresh_token,scope&limit=1`
  const response = await fetchImpl(endpoint(config, query), { headers: headers(config) })
  if (!response.ok) throw await failed('read', response)

  const rows = (await response.json()) as ConnectionRow[]
  const row = rows[0]
  if (!row?.refresh_token) return null
  return { refreshToken: row.refresh_token, scope: row.scope ?? '' }
}

/**
 * Records a connection, replacing whatever was there before.
 *
 * Upsert rather than insert because reconnecting is a normal thing to do —
 * switching Google account, or re-granting a scope the app added in a later
 * release — and one row per user is what makes the read side unambiguous.
 */
export async function writeConnection(
  userId: string,
  connection: StoredConnection,
  config: StoreConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(endpoint(config, '?on_conflict=user_id'), {
    method: 'POST',
    headers: headers(config, {
      // `merge-duplicates` is PostgREST's upsert; `return=minimal` keeps the
      // refresh token out of the response body, so it cannot end up in a log.
      prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify({
      user_id: userId,
      refresh_token: connection.refreshToken,
      scope: connection.scope,
      updated_at: new Date().toISOString(),
    }),
  })
  if (!response.ok) throw await failed('save', response)
}

export async function deleteConnection(
  userId: string,
  config: StoreConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(endpoint(config, `?user_id=eq.${encodeURIComponent(userId)}`), {
    method: 'DELETE',
    headers: headers(config, { prefer: 'return=minimal' }),
  })
  if (!response.ok) throw await failed('remove', response)
}
