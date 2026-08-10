/**
 * Drops `approval_prompt` from the Google connection's upstream parameters.
 *
 * It was there to make Google re-show consent, because only a consent screen
 * produces a refresh token and only a refresh token reaches Token Vault. The
 * connected-accounts flow asks for consent itself, with `prompt` — and Google
 * refuses a request carrying both, with "Conflict params: approval_prompt and
 * prompt". So the older of the two has to go, and loses nothing: forcing consent
 * on every ordinary sign-in was a cost, not a feature.
 *
 * `access_type=offline` stays. It is what makes the grant renewable at all.
 *
 * Usage:
 *
 *   AUTH0_DOMAIN=… AUTH0_MGMT_TOKEN=… node scripts/auth0-connection-upstream.mjs con_xxx
 *   AUTH0_DOMAIN=… AUTH0_MGMT_TOKEN=… node scripts/auth0-connection-upstream.mjs con_xxx --apply
 *
 * Dry by default, and it prints the before and after, because a connection PATCH
 * replaces `options` wholesale rather than merging into it: this reads the whole
 * object back, removes one key, and writes all of it. Get that wrong and the
 * client id, the scopes and the Token Vault settings go with it.
 *
 * `client_secret` is never returned by a read, so it cannot be written back
 * here. Auth0 keeps the stored one when a write omits it — but that is the risky
 * part of this file, so it verifies afterwards and tells you what to check.
 */

const domain = (process.env.AUTH0_DOMAIN ?? '').trim().replace(/^https?:\/\//, '')
const token = (process.env.AUTH0_MGMT_TOKEN ?? '').trim()
const connectionId = process.argv[2]
const apply = process.argv.includes('--apply')

if (!domain || !token || !connectionId || connectionId.startsWith('--')) {
  console.error(
    'Usage: AUTH0_DOMAIN=… AUTH0_MGMT_TOKEN=… node scripts/auth0-connection-upstream.mjs <connection-id> [--apply]',
  )
  process.exit(1)
}

async function api(path, init = {}) {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path} -> ${response.status}: ${body.message ?? JSON.stringify(body)}`,
    )
  }
  return body
}

const connection = await api(`/connections/${connectionId}`)
const options = connection.options ?? {}
const upstream = options.upstream_params ?? {}

console.log(`Connection  ${connection.name}  (${connection.id})`)
console.log(`  before    ${JSON.stringify(upstream)}`)

if (!('approval_prompt' in upstream)) {
  console.log('\n✓ approval_prompt is already gone. Nothing to do.')
  process.exit(0)
}

const { approval_prompt, ...kept } = upstream
// An empty object is not the same as an absent key to every consumer, so the
// whole parameter goes when nothing is left in it.
const nextUpstream = Object.keys(kept).length ? kept : undefined
const nextOptions = { ...options, ...(nextUpstream ? { upstream_params: nextUpstream } : {}) }
if (!nextUpstream) delete nextOptions.upstream_params

console.log(`  after     ${nextUpstream ? JSON.stringify(nextUpstream) : '(upstream_params removed)'}`)
console.log(`  keeping   client_id, ${Array.isArray(options.scope) ? options.scope.length : 0} scope(s), offline_access=${options.offline_access === true}`)

if (!apply) {
  console.log('\nDry run. Re-run with --apply to make the change.')
  process.exit(0)
}

await api(`/connections/${connectionId}`, {
  method: 'PATCH',
  body: JSON.stringify({ options: nextOptions }),
})

// Read back rather than trust the write. The failure this guards against is a
// silent one: an options object that came back missing something nobody looked
// at until a login broke hours later.
const after = await api(`/connections/${connectionId}`)
const check = after.options ?? {}
console.log('\nAfter the write:')
console.log(`  upstream_params  ${JSON.stringify(check.upstream_params ?? '(none)')}`)
console.log(`  client_id        ${check.client_id ?? '*** MISSING — re-enter the Google client id and secret ***'}`)
console.log(`  offline_access   ${check.offline_access === true}`)
console.log(`  scopes           ${(check.scope ?? []).join(' ')}`)
console.log(
  '\nThe secret cannot be read back at all, so sign in once to prove it survived.\n' +
    'A connection that lost it falls back to Auth0 development keys, and the tell is\n' +
    'on Google’s own screen: "auth0.com wants access" rather than your app’s name.',
)
