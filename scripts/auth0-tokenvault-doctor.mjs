/**
 * Reads back what Auth0 actually holds, when the dashboard says otherwise.
 *
 * Token Vault fails in one direction and reports it in another: the exchange
 * answers `federated_connection_refresh_token_not_found` from a backend client
 * that is configured perfectly, because the *connection* never asked Google for
 * a refresh token, or the *application* was never issued one to hang a token set
 * on. Three objects have to agree, and the dashboard renders each of them on a
 * different page, with checkboxes that look identical whether or not they saved.
 *
 * So this reads the objects rather than the pages.
 *
 * Usage:
 *
 *   AUTH0_DOMAIN=your-tenant.us.auth0.com \
 *   AUTH0_MGMT_TOKEN=eyJ... \
 *   node scripts/auth0-tokenvault-doctor.mjs
 *
 * The token is a Management API token. The quickest one to get is the test token
 * on Dashboard -> Applications -> APIs -> Auth0 Management API -> API Explorer,
 * which lasts a day and needs no application of its own. For the identity check
 * it must carry `read:user_idp_tokens`; without it everything else still runs
 * and that one section says so rather than failing.
 */

const domain = (process.env.AUTH0_DOMAIN ?? '').trim().replace(/^https?:\/\//, '')
const token = (process.env.AUTH0_MGMT_TOKEN ?? '').trim()

if (!domain || !token) {
  console.error('Set AUTH0_DOMAIN and AUTH0_MGMT_TOKEN. See the header of this file.')
  process.exit(1)
}

const YES = '✓'
const NO = '✗'
const mark = (ok) => (ok ? YES : NO)

async function api(path) {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = body.message ?? body.error_description ?? JSON.stringify(body)
    throw new Error(`GET ${path} -> ${response.status}: ${detail}`)
  }
  return body
}

/** The Google social connections, whichever names this tenant gave them. */
async function googleConnections() {
  const all = await api('/connections?strategy=google-oauth2')
  return Array.isArray(all) ? all : []
}

/**
 * Whether the connection will ask Google for a refresh token, and keep it.
 *
 * `offline_access` in the scope list is the Offline Access checkbox; without it
 * Auth0 never sends `access_type=offline` and Google issues an access token
 * alone, however many consent screens the user works through.
 */
function reportConnection(connection) {
  const options = connection.options ?? {}
  const scopes = Array.isArray(options.scope)
    ? options.scope
    : String(options.scope ?? '')
        .split(/[\s,]+/)
        .filter(Boolean)

  // Not an entry in `scope`, despite sitting among the scopes in the dashboard:
  // Auth0 keeps every Google permission as a boolean of its own on `options`,
  // and `scope` carries only the raw OAuth strings. Reading it out of `scope`
  // reports a connection that is set up correctly as broken.
  const offline = options.offline_access === true
  const drive = scopes.some((scope) => scope.includes('drive'))
  // Auth0's shared development keys leave both of these empty. A connection on
  // them signs users in perfectly and stores nothing.
  const ownKeys = Boolean(options.client_id)

  console.log(`\nCONNECTION  ${connection.name}  (${connection.id})`)
  console.log(`  ${mark(ownKeys)} own Google client   ${options.client_id ?? '— using Auth0 dev keys —'}`)
  console.log(`  ${mark(offline)} offline_access      ${offline ? 'set' : 'MISSING: no refresh token will ever be issued'}`)
  console.log(`  ${mark(drive)} a drive scope       ${scopes.filter((s) => s.includes('drive')).join(', ') || '— none —'}`)
  console.log(`    all scopes        ${scopes.join(' ') || '— none —'}`)

  if (options.upstream_params) {
    console.log(`    upstream_params   ${JSON.stringify(options.upstream_params)}`)
  }

  // Where the Token Vault purpose lives varies by tenant vintage, so rather than
  // guess at a field name, print the whole object with the secret taken out and
  // read it. Every hour lost on this has been spent trusting a rendered
  // checkbox over the record behind it.
  const purposes = [
    connection.authentication?.active ? 'authentication' : null,
    connection.connected_accounts?.active ? 'connected accounts (Token Vault)' : null,
  ].filter(Boolean)
  console.log(
    `  ${mark(connection.connected_accounts?.active)} purpose             ${purposes.join(' + ') || 'NONE: nothing will be written to Token Vault'}`,
  )

  if (process.argv.includes('--raw')) {
    const redacted = JSON.parse(JSON.stringify(connection))
    for (const key of ['client_secret', 'tenant_id']) delete redacted.options?.[key]
    // Every false boolean is a Google product nobody enabled; printing all
    // ninety of them buries the four that matter.
    for (const [key, value] of Object.entries(redacted.options ?? {})) {
      if (value === false) delete redacted.options[key]
    }
    console.log('    ── connection object, secret and unset scopes stripped ──')
    console.log(
      JSON.stringify(redacted, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    )
  }

  return connection
}

/**
 * Whether the browser application is issued a refresh token at all.
 *
 * A public client with rotation off is refused one outright, which leaves no
 * token set for Token Vault to file Google's credentials against — and surfaces
 * three steps later as `tokenset_not_found`.
 */
function reportClient(client) {
  const grants = client.grant_types ?? []
  const refresh = client.refresh_token ?? {}
  const rotating = refresh.rotation_type === 'rotating'
  const hasGrant = grants.includes('refresh_token')

  console.log(`\nAPPLICATION  ${client.name}  (${client.client_id})`)
  console.log(`  ${mark(client.app_type === 'spa')} app_type            ${client.app_type}`)
  console.log(`  ${mark(hasGrant)} refresh_token grant ${hasGrant ? 'enabled' : 'MISSING'}`)
  console.log(`  ${mark(rotating)} rotation_type       ${refresh.rotation_type ?? '(unset)'}`)
  console.log(`    expiration_type   ${refresh.expiration_type ?? '(unset)'}`)
  console.log(`    token_lifetime    ${refresh.token_lifetime ?? '(unset)'}`)
  console.log(`    grant_types       ${grants.join(', ')}`)

  // What the browser needs before it can run the connect flow that actually
  // fills Token Vault. A refresh token that cannot be exchanged for a
  // My Account API token leaves the flow unreachable, and the policy list is
  // Management-API-only — there is no dashboard for it to disagree with.
  const policies = refresh.policies ?? []
  const reachesMyAccount = policies.some((policy) => String(policy.audience ?? '').endsWith('/me/'))
  console.log(
    `  ${mark(reachesMyAccount)} MRRT policy         ${
      policies.length
        ? policies.map((policy) => policy.audience).join(', ')
        : 'none — refresh token reaches the default audience only'
    }`,
  )
  console.log(`  ${mark(client.cross_origin_auth === true)} cross_origin_auth   ${client.cross_origin_auth === true ? 'on' : 'off'}`)

  if (client.app_type === 'spa' && !rotating) {
    console.log('    ^ a browser client without rotation is refused a refresh token entirely.')
  }
}

/**
 * Whether Google actually handed a refresh token over for this user.
 *
 * The decisive one. Everything above is configuration that ought to produce a
 * refresh token; this is whether one exists.
 */
async function reportUser(email) {
  const found = await api(`/users-by-email?email=${encodeURIComponent(email)}`)
  if (!found.length) {
    console.log(`\nUSER  ${email}\n  not found in this tenant.`)
    return
  }

  for (const user of found) {
    console.log(`\nUSER  ${user.email}  (${user.user_id})`)
    console.log(`    logins_count      ${user.logins_count ?? 0}`)
    // The decisive one, and the distinction the whole afternoon turned on:
    // `identities` is the classic per-identity IdP token store, and Token Vault
    // reads none of it. The vault's own store is `connected_accounts`, which a
    // plain login does not write — it is filled by the My Account API connect
    // flow. An identity carrying a refresh token beside an empty
    // `connected_accounts` is exactly `tokenset_not_found`.
    let connected = []
    try {
      connected = await api(`/users/${encodeURIComponent(user.user_id)}/connected-accounts`)
      if (!Array.isArray(connected)) connected = connected?.connected_accounts ?? []
    } catch (error) {
      console.log(`  ? connected_accounts  could not read: ${error.message}`)
      connected = null
    }
    if (connected) {
      console.log(
        `  ${mark(connected.length > 0)} connected_accounts  ${connected.length} entr${connected.length === 1 ? 'y' : 'ies'}` +
          (connected.length ? ` (${connected.map((a) => a.connection ?? a.provider).join(', ')})` : ' — Token Vault holds nothing for this user'),
      )
    }

    for (const identity of user.identities ?? []) {
      const has = Boolean(identity.refresh_token)
      console.log(`  ${mark(has)} ${identity.provider}  refresh_token ${has ? 'present' : 'ABSENT'}`)
      if (identity.access_token && !has) {
        console.log('    ^ Google returned an access token and no refresh token: either the')
        console.log('      connection did not ask for offline access, or consent already stood.')
      }
    }
  }
}

const email = process.argv[2]

try {
  const connections = await googleConnections()
  if (!connections.length) console.log('\nNo google-oauth2 connection in this tenant.')
  connections.forEach(reportConnection)

  const clients = await api('/clients?fields=client_id,name,app_type,grant_types,refresh_token&include_fields=true')
  for (const client of clients) {
    // Every application the tenant has that a browser could be signing in with.
    if (client.app_type === 'spa' || client.app_type === 'regular_web') reportClient(client)
  }

  if (email) {
    try {
      await reportUser(email)
    } catch (error) {
      console.log(`\nUSER  ${email}\n  could not read: ${error.message}`)
      console.log('  (identities need a token with read:user_idp_tokens)')
    }
  } else {
    console.log('\nPass an email address to also check whether Google issued a refresh token.')
  }
} catch (error) {
  console.error(`\n${error.message}`)
  process.exit(1)
}
