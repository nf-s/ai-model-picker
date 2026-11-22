# Google sign-in

The site stays public. Google sign-in lets the configured administrator grant
other Google accounts access to benchmark results whose source terms do not
allow republishing. Signed-in, granted users fetch those results from
`/api/restricted`. Sessions last 8 hours and use host-only cookies.

The code is ported from the Google-only implementation in the sibling Plato
Explorer project. Cookie names (`__Host-picker-*`) and the callback failure
redirect (`/#/account?error=<code>`) differ, because this app is a hash-routed
single-page app.

## Layout

- `server/auth/`: authentication service, D1 store and Google ID-token checks.
- `server/restricted.mjs`: the shared access check and response for protected JSON.
- `server/routes.mjs`: route selection shared by the Pages Functions.
- `functions/auth/[[path]].js` and `functions/api/[[path]].js`: Pages Functions
  entry points. Shared modules stay outside `functions/`, where every file
  becomes a route. Static assets are served directly by Pages.

## Configuration

| Name                   | Kind         | Value                                                         |
| ---------------------- | ------------ | ------------------------------------------------------------- |
| `AUTH_DB`              | D1 binding   | Account database `ai-model-picker-access`                     |
| `PUBLIC_URL`           | Variable     | Canonical HTTPS origin, without a path or query               |
| `ADMIN_EMAIL`          | Variable     | Administrator Google email                                    |
| `GOOGLE_CLIENT_ID`     | Pages secret | Google Web application OAuth client ID                        |
| `GOOGLE_CLIENT_SECRET` | Pages secret | Google OAuth client secret                                    |
| `ADMIN_SUBJECT`        | Pages secret | Optional Google subject (`sub`) binding for the administrator |

Copy `wrangler.example.jsonc` to `wrangler.jsonc` (ignored by Git) and replace
the placeholders, or set the same bindings and variables in the Pages project
settings. Set secrets with `wrangler pages secret put <NAME> --project-name ai-model-picker`.
Never put secrets, account identifiers or database identifiers in tracked
files. Downloaded `client_secret*.json` files and `.dev.vars*` are ignored.

In the Google Cloud console, create a Web application OAuth client with the
authorized redirect URI:

```text
https://ai-model-picker.pages.dev/auth/google/callback
```

The redirect URI is always `${PUBLIC_URL}/auth/google/callback`. Every
request's origin must equal `PUBLIC_URL`. Preview deployment URLs, custom
domains and `wrangler pages dev` (plain HTTP) therefore receive
`invalid_request` (400) from the auth routes and `/api/restricted` unless
`PUBLIC_URL` and the Google redirect URI are changed to match.

Missing Google, origin or administrator configuration returns 503
`configuration_error`. A missing or unavailable `AUTH_DB` returns 503. Both
fail closed.

## Migration

Apply `migrations/0001_access.sql` once to a fresh, dedicated D1 database:

```sh
npx wrangler@4.163.0 d1 migrations apply ai-model-picker-access --remote
```

The command reads `migrations_dir` from `wrangler.jsonc`. Never apply the
migration to any other database.

## Routes

| Route                             | Request                               | Result                                                                                                                                          |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/google/start`          | Optional `next` local URL             | 303 to Google, sets browser-binding cookie                                                                                                      |
| `GET /auth/google/callback`       | Google `code`/`state`, binding cookie | 303 to the safe `next` URL with session and CSRF cookies; on failure 303 to `/#/account?error=<code>`                                           |
| `POST /auth/logout`               | Session, `X-CSRF-Token`, `Origin`     | `{ok:true}`; revokes the session and clears all four cookies                                                                                    |
| `GET /api/session`                | Session cookie                        | `{authenticated:false}` or `{authenticated:true,email,sub,isAdmin,csrfToken,expiresAt}`                                                         |
| `GET /api/enrollment`             | Enrollment cookie                     | `{enrollment:null}` or `{enrollment:{email,subject,expiresAt}}`                                                                                 |
| `GET /api/admin/access`           | Administrator session                 | `{adminEmail,grants:[{email,subject,enabled,isAdmin,updatedAt}]}`                                                                               |
| `POST /api/admin/access`          | `{email,subject?:string\|null}`       | Grant, re-enable or rebind; `{ok:true}`                                                                                                         |
| `DELETE /api/admin/access`        | `{email}`                             | Revoke the grant and its sessions; `{ok:true}`                                                                                                  |
| `GET`/`HEAD /api/restricted`      | Session of any granted user           | The ignored `.local/restricted/payload.json` (`{benchmarks, results, sources, evidence, attributions}`), bundled by `functions/api/[[path]].js` |
| `GET`/`HEAD /api/expert-articles` | Session of any granted user           | The ignored `.local/expert-articles/catalog.json` (`{articles: [{title, date, url}]}`), bundled by `functions/api/[[path]].js`                  |

Errors are JSON `{error,message}` with a 4xx or 5xx status. Unknown `/auth/*`
and `/api/*` paths return 404 `not_found`; known paths with another method
return 405 with `Allow`. Grant and revoke bodies are JSON objects of at most
4 KB sent with `Content-Type: application/json`; unknown fields are rejected.
Logout, grant and revoke require the exact `Origin: PUBLIC_URL` and the
session's `X-CSRF-Token`.

## Security properties

- Google authorization uses S256 PKCE, browser-bound one-use state, a nonce and
  RS256 ID-token verification against Google's fixed JWKS endpoint. Google
  access and refresh tokens are discarded.
- Session and CSRF tokens are random 256-bit values stored only as SHA-256
  hashes. The session cookie is Secure, HttpOnly and SameSite=Lax. The CSRF
  cookie is readable by the page. All cookies use `__Host-` names.
- Every protected request rechecks the session and enabled grant on the D1
  primary. Revocation ends all of that account's sessions immediately.
  Administrator writes recheck the administrator's session inside the same
  transaction.
- Gmail and Google Workspace accounts bind their Google subject on first
  sign-in. Other Google accounts need an administrator-approved subject: the
  callback sets a short-lived enrollment cookie and redirects with
  `error=enrollment_required`; `/api/enrollment` shows the verified email and
  subject to that browser only.
- The administrator is defined by configuration and cannot be granted or
  revoked through the API.
- Responses are `no-store`, `nosniff`, `no-referrer` and `noindex`.
  `/api/restricted` and `/api/expert-articles` are `private, no-store` with `Vary: Cookie`.
- Login, grant, revoke and logout events are recorded in `access_audit`
  without tokens.

## Verification

`npm test` runs the auth and restricted endpoint tests with real SQLite
transactions (`node:sqlite`) and real WebCrypto signatures. Check that the
Functions compile with:

```sh
npx wrangler@4.163.0 pages functions build --outdir <temporary directory>
```

Production D1 and Google sign-in need a separate check after deployment. Use an
existing granted account for that check.
