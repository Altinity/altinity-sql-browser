# Configuring the login screen

The sign-in screen offers up to three sign-in paths at once — SSO, a
ClickHouse® username/password, and a picker for connecting to a different
server — so a first-time visitor can see more controls than their deployment
actually needs (#123). All of it is a `config.json` choice; this page is the
full reference for that config, and for what each part of the screen does.

## Configuring OAuth

`config.json` carries the `issuer`, `client_id`, and optionally `client_secret`
and `audience`. `config.json` is served to browsers, so the right shape depends
on your IdP and threat model. Common, all valid, variants:

- **Public client + PKCE (no secret).** Register a "SPA / public / native"
  client; the PKCE `code_verifier` authenticates the token exchange, so no
  `client_secret` is needed and `config.json` stays secret-free. Supported by
  most OIDC providers.
- **Web client that requires a secret.** Some providers (e.g. a Google "Web
  application" client) require `client_secret` on the in-browser token exchange
  even with PKCE. The code accepts `client_secret` in `config.json` for this
  case. Since it ships to browsers, pair it with a redirect URI locked to
  exactly `https://<host>/sql` and a suitably scoped consent screen.
- **Broker server-side.** Front the app with an OIDC broker / auth proxy that
  holds the provider secret and exposes a public PKCE client; the browser talks
  only to the broker and `config.json` carries no secret. More moving parts,
  keeps every provider secret off the browser.

The code treats `client_secret` as optional, so any of these is a config-only
choice.

### Multiple IdPs

`config.json` may instead list several providers, and the login screen shows
one button per IdP ("Continue with …") rather than a single one:

```json
{ "idps": [
    { "id": "google", "label": "Google",   "issuer": "https://accounts.google.com", "client_id": "…" },
    { "id": "acme",   "label": "Acme SSO", "issuer": "https://acme.auth0.com",      "client_id": "…", "client_secret": "…" }
  ] }
```

Each entry takes the same fields as the single-IdP form (`issuer`, `client_id`,
optional `client_secret`/`audience`/`bearer`/`ch_auth`/`authorize_params`) plus an
optional `id`/`label` (default: the issuer host). A bare single object (above) is
still accepted — it's treated as a one-IdP list. ClickHouse needs a matching
`<token_processor>` per issuer; it validates each inbound JWT against whichever
one matches the token's `iss`, so no extra CH wiring is required to offer several.

## Credentials login (username / password)

Alongside SSO, the sign-in screen offers a **ClickHouse username + password**
path (HTTP Basic), shown by default.

**Hide it (SSO-only).** If the cluster has no password-authenticated CH users —
e.g. it only accepts JWTs via a `token_processor`/verifier — the credentials path
would just 401, so set top-level `"basic_login": false` to drop it and offer SSO
only. This is also the way to get the simplest possible screen — a single
SSO button, with no credentials panel, Advanced disclosure, or Target row at
all:

```json
{
  "basic_login": false,
  "idps": [ { "id": "google", "issuer": "https://accounts.google.com", "client_id": "…" } ]
}
```

(Some verifier setups *do* pass real CH password users through — e.g. a cluster
with a `demo` user still accepts `demo`/password — so whether to hide the path is
about what that server actually authenticates, not just "does it use OAuth".)

**Credentials-only (no SSO).** A deployment with no OAuth can omit `idps`
entirely; the SSO buttons disappear and only the username/password form shows
(`basic_login` defaults on):

```json
{}
```

### The host (Advanced → Server address)

Credentials authenticate against the **serving host** by default. The login
screen's **Advanced → Server address** field can aim the credential path at a
**different** `host:port` (a bare host defaults to `https://…:8443`); SSO always
stays on the serving host. This disclosure is **folded closed by default** — it
only opens when:

- a **`?host=` URL param** pre-fills it — e.g. `…/sql?host=other.example:9000`
  opens Advanced with the address filled in and **disables the SSO buttons**
  (SSO can only target the serving host), so the link drops you straight into
  credential sign-in for that server; or
- a **saved-connection picker** is populated (see below) and the user selects a
  plain/basic entry from it, which prefills the credentials form and opens
  Advanced.

So a standard hosted, single-cluster deployment (`deploy/install.sh`, no
`hosts` in `config.json`, no `?host=` links handed out) never shows this
disclosure to its users — there's nothing to configure to hide it; it simply
never opens.

A cross-origin target (a host other than the one serving the page) has two
extra requirements:

- **The SPA's own CSP.** `deploy/http_handlers.xml` sets `connect-src 'self'`
  (+ the IdP origins). The browser will block a query POST to any other origin
  until you add that origin to `connect-src` — otherwise the request never
  leaves the page.
- **The target ClickHouse must allow CORS** for this origin: answer the
  `Authorization`-header preflight (`OPTIONS`) and return
  `Access-Control-Allow-Origin`. ClickHouse's `add_http_cors_header` covers the
  actual request; the preflight may need handler/proxy configuration on that
  server.

The password is held in `sessionStorage` for the tab session (same lifetime as
the OAuth token) and sent as `Authorization: Basic base64(user:password)`. A
wrong password is surfaced on the login screen — the connect probe runs a
`SELECT 1` before entering the workbench.

### The saved-connection picker (multi-host)

The **Saved connection** dropdown above the login card is only ever populated
by **local development** — `npm run local` (or the installed local app) reads
your **`~/.clickhouse-client/config.xml`** connections into `config.json`'s
`hosts` list:

- A plain connection (`hostname`/`user`/`password`) → selecting it prefills the
  credentials form (cross-origin HTTP Basic to that host) and opens Advanced.
- A connection carrying clickhouse-client's OAuth keys (`oauth-url`,
  `oauth-client-id`, `oauth-audience`) → selecting it starts an OAuth sign-in
  against that cluster instead.

A connection with `<accept-invalid-certificate>1</accept-invalid-certificate>`
(a self-signed or wrong-host TLS cert, common on dev tenants) is flagged in the
picker. The browser refuses to `fetch()` such a host and JavaScript can't
override that, so selecting it surfaces a one-time step: open the cluster in a
new tab and accept its certificate, after which the SPA can reach it for the
rest of the browser session. For an OAuth connection, the sign-in redirect is
held behind a **Continue** button so the cert is trusted before any post-login
query hits the cluster.

A hosted, single-cluster deployment doesn't set `hosts`, so its users never see
this picker — it's purely a local/dev-tool feature, not something a production
deployment needs to hide.

## Reference

- [README "Installing on any ClickHouse cluster"](../README.md#installing-on-any-clickhouse-cluster)
  — the installer that renders `config.json` and wires up ClickHouse.
- [docs/CLICKHOUSE-OAUTH.md](CLICKHOUSE-OAUTH.md) / [docs/CLICKHOUSE-OSS-OAUTH.md](CLICKHOUSE-OSS-OAUTH.md)
  — the ClickHouse-side JWT verification wiring (`<token_processors>` or a
  delegated verifier) that a `config.json` issuer must pair with.
- [SECURITY.md](../SECURITY.md) — the full threat model for why `config.json`
  is public, the redirect-lock requirement, and token storage.
