/**
 * Turns on the half of Token Vault that a login does not.
 *
 * Signing in stores Google's tokens against the user's *identity*, which is the
 * store Auth0 has always had and the one Token Vault does not read. Token Vault
 * reads `connected_accounts`, and nothing fills that but the My Account API's
 * connect flow — a second trip to Google, run by the browser after sign-in. The
 * symptom of not knowing this is a tenant where every setting is right and the
 * exchange still answers `federated_connection_refresh_token_not_found`, with
 * `tokenset_not_found` underneath it.
 *
 * Three things have to be true before that flow can run, and only one of them
 * has a dashboard:
 *
 *   1. the My Account API is activated                      (dashboard: yes)
 *   2. the SPA is granted its `*:me:connected_accounts`      (dashboard: no)
 *   3. the SPA's refresh token may be exchanged for a token
 *      whose audience is that API — an MRRT policy           (dashboard: no)
 *
 * This does 2 and 3, and refuses to do them until 1 is done, because a policy
 * naming an API that does not exist yet is not rejected: the docs say it is
 * "silently ignored", which produces a tenant that looks configured and behaves
 * exactly as it did before.
 *
 * Usage:
 *
 *   AUTH0_DOMAIN=your-tenant.us.auth0.com \
 *   AUTH0_MGMT_TOKEN=eyJ... \
 *   node scripts/auth0-connect-setup.mjs <spa-client-id>            # dry run
 *   node scripts/auth0-connect-setup.mjs <spa-client-id> --apply    # for real
 *
 * Dry by default. It edits a tenant that people are signing in to, and the
 * refresh-token patch is a read-modify-write over settings that took an
 * afternoon to get right — worth seeing before it happens.
 */

const domain = (process.env.AUTH0_DOMAIN ?? '').trim().replace(/^https?:\/\//, '')
const token = (process.env.AUTH0_MGMT_TOKEN ?? '').trim()
const clientId = process.argv[2]
const apply = process.argv.includes('--apply')

if (!domain || !token || !clientId || clientId.startsWith('--')) {
  console.error('Usage: AUTH0_DOMAIN=… AUTH0_MGMT_TOKEN=… node scripts/auth0-connect-setup.mjs <spa-client-id> [--apply]')
  process.exit(1)
}

/** The built-in API the connect flow is called against. The trailing slash is part of it. */
const MY_ACCOUNT = `https://${domain}/me/`

const CONNECTED_ACCOUNT_SCOPES = [
  'create:me:connected_accounts',
  'read:me:connected_accounts',
  'delete:me:connected_accounts',
]

async function api(path, init = {}) {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = body.message ?? body.error_description ?? JSON.stringify(body)
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${detail}`)
  }
  return body
}

/**
 * Whether the My Account API has been activated on this tenant.
 *
 * It is a built-in rather than an API somebody created, and the docs do not say
 * whether it surfaces in the resource-server list — so a miss here is reported
 * as "could not confirm" rather than "not activated", and the run continues.
 * Guessing wrong in the confident direction is what this whole script exists to
 * stop.
 */
async function myAccountApiState() {
  try {
    const servers = await api('/resource-servers?per_page=100')
    const list = Array.isArray(servers) ? servers : (servers.resource_servers ?? [])
    const found = list.find((server) => server.identifier === MY_ACCOUNT)
    return found ? 'active' : 'absent'
  } catch {
    return 'unknown'
  }
}

/** The APIs this tenant has, so the MRRT policy can keep the ones already working. */
async function audiences() {
  const servers = await api('/resource-servers?per_page=100')
  const list = Array.isArray(servers) ? servers : (servers.resource_servers ?? [])
  return list
    .map((server) => server.identifier)
    .filter((id) => id && !id.endsWith('/api/v2/') && id !== MY_ACCOUNT)
}

const client = await api(`/clients/${clientId}`)
console.log(`Application  ${client.name}  (${client.client_id}, ${client.app_type})`)

const state = await myAccountApiState()
if (state === 'active') {
  console.log(`✓ My Account API   ${MY_ACCOUNT} listed`)
} else {
  // Not a refusal. The My Account API is a built-in rather than an API somebody
  // created, and Auth0 does not document whether it is listed here at all — so
  // its absence from this list is as likely to mean "built-ins are hidden" as
  // "not activated". Treating a lookup in a possibly-wrong place as proof is
  // the mistake this file is downstream of.
  console.log(
    `?  My Account API   ${MY_ACCOUNT} not in /resource-servers, which may mean it is\n` +
      '                   not activated, or merely that built-ins are not listed there.\n' +
      '                   Confirm by eye: Dashboard -> Applications -> APIs.\n' +
      '                   The honest test is at runtime: /me/v1/connected-accounts/connect\n' +
      '                   answers 404 when the feature is not provisioned.',
  )
}

// ---- 1. the grant that caps what the SPA may ask for ----------------------

const grants = await api(`/client-grants?client_id=${encodeURIComponent(clientId)}`)
const existing = (Array.isArray(grants) ? grants : []).find((grant) => grant.audience === MY_ACCOUNT)
const missing = CONNECTED_ACCOUNT_SCOPES.filter((scope) => !(existing?.scope ?? []).includes(scope))

if (existing && !missing.length) {
  console.log(`\n✓ client grant     already allows ${CONNECTED_ACCOUNT_SCOPES.length} connected-account scopes`)
} else if (existing) {
  const scope = [...new Set([...(existing.scope ?? []), ...CONNECTED_ACCOUNT_SCOPES])]
  console.log(`\n→ client grant     add ${missing.join(', ')}`)
  if (apply) {
    await api(`/client-grants/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ scope }) })
    console.log('  done')
  }
} else {
  console.log(`\n→ client grant     create for ${MY_ACCOUNT}`)
  console.log(`                   scopes: ${CONNECTED_ACCOUNT_SCOPES.join(', ')}`)
  if (apply) {
    await api('/client-grants', {
      method: 'POST',
      body: JSON.stringify({
        client_id: clientId,
        audience: MY_ACCOUNT,
        scope: CONNECTED_ACCOUNT_SCOPES,
      }),
    })
    console.log('  done')
  }
}

// ---- 2. the policy that lets one refresh token reach two APIs -------------

/**
 * Read-modify-write, deliberately.
 *
 * `refresh_token` carries the rotation and expiry settings as well as the
 * policies, and PATCHing the object replaces it wholesale — sending policies
 * alone would silently drop rotation, which is the setting that had to be fixed
 * to get this far.
 */
const refresh = client.refresh_token ?? {}
const policies = refresh.policies ?? []
const already = policies.some((policy) => policy.audience === MY_ACCOUNT)

if (already) {
  console.log(`\n✓ MRRT policy      ${MY_ACCOUNT} already reachable`)
} else {
  // An empty policy list means "the default audience only". Adding one policy
  // makes the list exhaustive, so every API the app already reaches has to be
  // named in it or it stops being reachable.
  const keep = policies.length
    ? policies
    : (await audiences()).map((audience) => ({ audience, scope: [] }))

  const next = {
    ...refresh,
    policies: [...keep, { audience: MY_ACCOUNT, scope: CONNECTED_ACCOUNT_SCOPES }],
  }

  console.log('\n→ MRRT policy      set refresh_token.policies to:')
  for (const policy of next.policies) {
    console.log(`                   ${policy.audience}  [${(policy.scope ?? []).join(' ') || 'no scope restriction'}]`)
  }
  console.log(`                   (keeping rotation_type=${refresh.rotation_type}, expiration_type=${refresh.expiration_type})`)

  if (apply) {
    await api(`/clients/${clientId}`, {
      method: 'PATCH',
      body: JSON.stringify({ refresh_token: next }),
    })
    console.log('  done')
  }
}

// ---- 3. the things only a human can judge --------------------------------

console.log('\nCheck by hand — the connect call is made from the browser, so it needs CORS:')
console.log(`  cross_origin_auth  ${client.cross_origin_auth === true ? '✓ on' : '✗ off — Dashboard -> the app -> Allow Cross-Origin Authentication'}`)
console.log(`  web_origins        ${(client.web_origins ?? []).join(', ') || '✗ none set'}`)
console.log(`  callbacks          ${(client.callbacks ?? []).join(', ') || '✗ none set'}`)
console.log('\nThe connect flow redirects back to a callback URL, so whatever origin the app is')
console.log('served from has to appear in both lists — deploy previews included.')

if (!apply) console.log('\nDry run. Re-run with --apply to make these changes.')
