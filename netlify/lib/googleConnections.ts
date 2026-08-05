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
 */
export function storeConfig(): StoreConfig | null {
  const url = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
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

/** Turns a PostgREST failure into something a log line can be read from. */
async function failed(action: string, response: Response): Promise<Error> {
  let detail = ''
  try {
    detail = await response.text()
  } catch {
    // Body already consumed or unreadable; the status still says enough.
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
