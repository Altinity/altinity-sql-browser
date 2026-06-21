# Altinity SQL Browser

A zero-dependency, OAuth-gated **SQL browser for any ClickHouse cluster** —
schema explorer, tabbed SQL editor with syntax highlighting, streaming results
with table / JSON / chart views, saved queries, history, and shareable links.
It ships as a **single self-contained HTML file served from ClickHouse itself**
(no Node server, no CDN, no external fonts, no runtime dependencies) — the page
makes **zero third-party requests** and renders in the OS's native UI font.

Refactored from a single-file SPA into a fully modular, test-first codebase
held at **100% test coverage**.

## How it works

```
browser ──https──▶ ClickHouse  GET /sql            → the SPA (one HTML file)
                              GET /sql/config.json → { issuer, client_id }
   │  OAuth2 Authorization-Code + PKCE via OIDC discovery (any IdP)
   │  id_token kept in sessionStorage, silently refreshed
   ▼
ClickHouse  POST /  Authorization: Bearer <id_token>   ← every query
            (validated by CH token_processor/JWKS, or a delegated verifier)
```

The browser never holds a static credential — each user authenticates with your
IdP and ClickHouse sees their JWT. There is **no app-specific backend**: the
only moving parts are ClickHouse's HTTP handlers and your OAuth provider.

## Quick start (development)

```bash
npm install            # esbuild ships platform-specific binaries; use install, not ci
npm test               # vitest + 100% coverage gate
npm run build          # → dist/sql.html (single file)
npm run dev            # build + serve dist/ at http://localhost:8900
```

## Installing on any ClickHouse cluster

```bash
CLICKHOUSE_PASSWORD=… ./deploy/install.sh \
  --ch-host clickhouse.example.com \
  --ch-user admin \
  --client-id <your-oauth-client-id> \
  [--issuer https://accounts.google.com] \
  [--audience <api-audience>] \   # audience-gated CH → also sends the access_token
  [--ch-auth basic] \             # OSS CH + ch-jwt-verify → JWT as Basic password
  [--cluster <cluster-name>]      # single-shard multi-replica only (else per-node)
```

With **no** `--audience`, the IdP returns an **id_token** (its `aud` is the
client_id) and the browser sends that as the bearer — so ClickHouse's
`expected_audience` must be the **client_id**, not an API audience. Passing
`--audience` switches to the **access_token** path. See `docs/CLICKHOUSE-OAUTH.md`.

The installer builds `dist/sql.html`, renders `config.json`, renders
`dist/http_handlers.xml` (with the CSP `connect-src` filled in for your issuer —
see "Security headers" below), and uploads the SPA + config into ClickHouse
`user_files/`. Then:

1. Add the rendered `dist/http_handlers.xml` to the server's `config.d/` (or push
   it as an ACM cluster setting `config.d/sql-browser.xml`) and reload ClickHouse.
2. Register the redirect URI `https://<ch-host>/sql` with your OAuth IdP.
3. Make sure ClickHouse accepts the bearer JWT — either a CH
   `<token_processors>` entry validating your IdP's JWKS, or a delegated
   `<http_authentication_servers>` verifier. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Configuring OAuth

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

#### Multiple IdPs

`config.json` may instead list several providers, and the login screen shows one
button per IdP ("Sign in with …"):

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

### Security headers

`deploy/http_handlers.xml` sends a strict **Content-Security-Policy** plus
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on the SPA
response. The CSP is `default-src 'none'` with everything re-allowed explicitly:

- `script-src`/`style-src 'unsafe-inline'` — the JS and CSS are inlined into the
  single HTML file, so they can't be matched by `'self'`. (No `eval`, no remote
  scripts; the real protection below is `connect-src`.)
- `connect-src 'self' <issuer-origins>` — the one that matters: it bounds where
  the page can send data, so an injected script can't exfiltrate the
  `sessionStorage` tokens to an attacker. `'self'` covers ClickHouse queries +
  `config.json`; the IdP origins cover OIDC discovery and the token endpoint.
- `img-src data:`, `frame-ancestors 'none'` (anti-clickjacking), `base-uri 'none'`.
- `frame-src 'self'` — lets the result cell-detail drawer preview an HTML value
  in a `sandbox=""` (script-less, inert) `srcdoc` iframe. The sandbox blocks any
  script/form/navigation, so the relaxation can't run injected code.

`install.sh` fills `connect-src` automatically: it fetches your issuer's OIDC
discovery document and rewrites the host list to your real issuer + token-endpoint
origins (falling back to the Google default if discovery is unreachable). For a
**manual install with a non-Google IdP**, edit the `connect-src` line in
`deploy/http_handlers.xml` to list your issuer + token-endpoint origins.

Preview the rendered artifacts without touching ClickHouse:

```bash
./deploy/install.sh --dry-run --client-id <id> [--issuer https://your-idp]
```

## Layout

```
src/
  core/      pure logic — format, jwt, pkce, sql-highlight, share, sort,
             stream, storage, chart-data (no DOM, no globals)
  net/       oauth-config, oauth, ch-client (injected fetch seam)
  ui/        dom (hyperscript), icons, + render modules (login, editor, tabs,
             schema, results, saved-history, shortcuts, splitters, toast, app)
  state.js   state model + pure operations
  main.js    bootstrap (OAuth callback, share-links, initial render)
  styles.css
build/        esbuild → single-file dist/sql.html
deploy/       install.sh, uninstall.sh, http_handlers.xml, config.json.example
tests/        vitest + happy-dom, one spec per module
docs/         ARCHITECTURE.md, DEPLOYMENT.md, ASSET-DISTRIBUTION.md,
              CLICKHOUSE-OAUTH.md, CLICKHOUSE-OSS-OAUTH.md
```

## Testing

```bash
npm test          # run once with coverage
npm run test:watch
```

Coverage is enforced **per file** (no global aggregate can hide a weak module).
Every module — pure logic, network, state, DOM, render modules, the controller,
and the bootstrap — is held at **100/100/100/100** (statements / branches /
functions / lines). The fetch, crypto, and storage seams are injected, so the
suite needs no mocking libraries.

## License

Apache-2.0.
