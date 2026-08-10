# Review request: Auth0 + Google Drive (Token Vault / Connected Accounts) setup

You are auditing a working-but-fragile production auth setup. I want you to find
configuration errors, missing steps, and things that will break later. Be
skeptical: assume at least one thing below is wrong or unnecessary. Cite Auth0
and Google documentation for every claim, and say clearly when you cannot verify
something rather than guessing.

## What the app does

A single-page React app (Vite, deployed on Netlify) signs users in with Google
via Auth0, and needs a Google Drive access token on the backend so Netlify
functions can write files to the user's own Drive folder (scope
`https://www.googleapis.com/auth/drive.file` only — no restricted scopes).

The backend never stores a Google refresh token. It exchanges the caller's Auth0
access token through **Auth0 Token Vault** for a Google access token on demand.

## Current configuration

### Google Cloud

- OAuth client type: **Web application**, client id
  `1025339495005-se9o9arufm1le8lmke7glgghv9sjf234.apps.googleusercontent.com`
- Authorized redirect URIs include
  `https://dev-1jsc8t57006ph7tk.us.auth0.com/login/callback`, plus several
  leftover app-side URIs from a previous direct-OAuth implementation
  (`https://editor-cat.netlify.app/oauth/google`, `http://localhost:8888/oauth/google`,
  `https://staging.editor.simka.cat/oauth/google`, and similar).
- OAuth consent screen ("Branding"): app name **Editor Cat**, support email set,
  authorized domains `auth0.com`, `editor-cat.netlify.app`,
  `staging--editor-cat.netlify.app`, `simka.cat`.
- Publishing status: **Testing** (not published/verified).
- Google Drive API and Google Picker API enabled. A separate browser API key is
  used for the Picker.

### Auth0 tenant `dev-1jsc8t57006ph7tk.us.auth0.com` (free trial, DEVELOPMENT)

**Connection `google-oauth2`** (`con_eBijvxlhZ5fFrK4y`):

- Uses the app's own Google client id/secret (not Auth0 developer keys).
- `options.scope`: `["email", "profile", "https://www.googleapis.com/auth/drive.file"]`
- `options.drive_file: true`, `options.offline_access: true`
- `options.upstream_params`: `{"access_type": {"value": "offline"}}`
  (`approval_prompt: force` was removed — see "History" below)
- `authentication: {active: true}` and `connected_accounts: {active: true}`
  (dashboard Purpose = "Authentication and Connected Accounts for Token Vault")

**Application "Editor Cat"** (`yjz5bZfd8n3tgaakGxH2cTVoLusmG4YW`):

- Type: **Single Page Application** (public client, PKCE)
- Grant types: `authorization_code`, `implicit`, `refresh_token`
- Refresh Token Rotation: **on**, rotation overlap 5s
- Refresh Token Expiration: absolute lifetime `31557600` seconds (1 year), idle
  expiration off
- MRRT `refresh_token.policies`:
  - `{audience: "https://editor-cat/api", scope: []}`
  - `{audience: "https://dev-1jsc8t57006ph7tk.us.auth0.com/me/", scope: ["create:me:connected_accounts", "read:me:connected_accounts", "delete:me:connected_accounts"]}`
- `cross_origin_auth`: **off**
- Allowed Callback URLs and Allowed Web Origins:
  `https://simka.cat`, `https://*.staging.simka.cat`, `http://localhost:5173`,
  `http://localhost:8888`

**API "Editor Cat"**, identifier `https://editor-cat/api`. Its **Custom API
Client** ("Editor Cat API Client", `LRwbKOdEaTfGrNcUxoKjxA2iTY2VPup5`) holds the
`AUTH0_BACKEND_CLIENT_ID` / `AUTH0_BACKEND_CLIENT_SECRET` used for the token
exchange. Token Vault grant enabled.

**Auth0 My Account API** (`https://dev-1jsc8t57006ph7tk.us.auth0.com/me/`):
activated. Under Application Access, "Editor Cat" has **User-Delegated Access**
with the three `*:me:connected_accounts` permissions (3/8). Client Access: none.
Its Settings tab has a Default Policy toggle **"Require 2FA"** which is
currently **ON** ("When a user accesses this API more than 15 minutes after
their initial login, they will be prompted for an additional factor").

### Application code

`@auth0/auth0-spa-js` v2.24.1, configured with:

```js
new Auth0Client({
  domain, clientId,
  authorizationParams: { audience: 'https://editor-cat/api', redirect_uri: window.location.origin },
  cacheLocation: 'localstorage',
  useRefreshTokens: true,
  useMrrt: true,
  useDpop: true,
})
```

Sign-in is identity-only (no `connection_scope`):

```js
await auth0().loginWithRedirect({
  authorizationParams: { connection: 'google-oauth2', redirect_uri: window.location.origin },
})
```

Drive is requested afterwards, as a separate screen:

```js
await auth0().connectAccountWithRedirect({
  connection: 'google-oauth2',
  scopes: ['https://www.googleapis.com/auth/drive.file'],
  redirectUri: window.location.origin,
  authorization_params: { login_hint: userEmail },
})
```

The redirect callback handler accepts `code`, `connect_code` or `error`, each
with `state`, and passes all of them to `handleRedirectCallback()`.

Backend exchange (Netlify function, authenticated as the Custom API Client):

```
POST https://{domain}/oauth/token
grant_type=urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token
subject_token_type=urn:ietf:params:oauth:token-type:access_token
requested_token_type=http://auth0.com/oauth/token-type/federated-connection-access-token
connection=google-oauth2
subject_token=<the caller's Auth0 access token for https://editor-cat/api>
```

## History — errors already hit and fixed

Each of these was a real failure, in this order:

1. `federated_connection_refresh_token_not_found` / `tokenset_not_found` on the
   backend exchange, while the user's `google-oauth2` **identity** had a valid
   `refresh_token`. Diagnosed as: a login writes IdP tokens to `identities`;
   Token Vault reads `connected_accounts`, which only the My Account API connect
   flow populates.
2. Auth0 refused to issue a refresh token to the SPA at all (tenant log warning
   about `offline_access` being requested) because **Refresh Token Rotation was
   off** on a public client.
3. `Client "..." is not authorized to access resource server ".../me/"` —
   because `POST /api/v2/client-grants` with `subject_type: "user"` was
   **silently stored as `subject_type: "client"`**. Only creating the grant
   through the dashboard's Application Access tab produced a working
   user-delegated grant.
4. `Unknown or invalid refresh token` — stale/rotated refresh token in
   localStorage after repeated failed exchanges.
5. Google: `Access blocked: Authorization Error — Conflict params:
   approval_prompt and prompt`, because the connection's
   `upstream_params.approval_prompt=force` collided with the `prompt` the
   connect flow sends itself. Removing `approval_prompt` fixed it.

After all five, the flow completed end-to-end once: sign in → "Allow Google
Drive" → Google consent → back to the app with a working Drive connection, and
the backend exchange returned a Google access token.

## Current state: working

The flow was then re-tested from scratch — the Auth0 user was **deleted** and
the app's access **revoked from the Google account**
(myaccount.google.com/permissions) — and a first-time sign-in completed
successfully: login, then "Allow Google Drive", one Google consent screen, back
to the app with a connected Drive.

So this is not a debugging request. It is a review of a setup that works but was
arrived at by trial and error, on a free trial tenant, against a feature
(Connected Accounts for Token Vault) that is new enough to have little public
documentation. Assume it is fragile rather than broken.

## What I want from you

1. **Is the overall architecture correct?** Should Drive be granted via the My
   Account API connect flow as a second screen, or is there a supported way to
   populate Token Vault from the initial login (making it one screen)? If the
   latter exists, what exactly is required?
2. **What will break this later, that is not broken now?** It works today for
   both new and existing users. I want the failures that arrive on a delay:
   refresh tokens expiring, consent going stale, the 1-year absolute lifetime
   elapsing, rotation breach-detection firing when two tabs refresh at once,
   Google's Testing-mode 7-day refresh token expiry, and what happens to a
   connected account when a user revokes access from their Google account page.
3. **Is `Require 2FA` on the My Account API a problem?** Does it block the
   connect flow, and what happens for a user who reconnects more than 15 minutes
   after signing in?
4. **Review every configuration value above** and flag anything wrong,
   redundant, or risky. Specifically: the 1-year refresh token lifetime; the
   empty `scope: []` on the `https://editor-cat/api` MRRT policy (does empty mean
   unrestricted or nothing?); `cross_origin_auth` being off while the browser
   calls the My Account API; the wildcard `https://*.staging.simka.cat` callback;
   and the leftover Google redirect URIs.
5. **Google Cloud specifics**: consequences of staying in Testing mode
   (including the 7-day refresh token expiry), whether `drive.file` requires
   verification, whether the `auth0.com` authorized domain is needed, and whether
   the leftover redirect URIs are a security problem.
6. **Anything missing entirely** — a setting, a grant, a scope, or a step that
   is not mentioned above but is required for Token Vault with Google.

Be concrete: name the exact dashboard location or Management API call for every
change you recommend, and state which of your claims you verified against
documentation versus inferred.
