# Altinity SQL Browser

A zero-dependency, OAuth-gated **SQL browser for any ClickHouse cluster** —
schema explorer, tabbed SQL editor with syntax highlighting, streaming results
with table / JSON / chart views, saved queries, history, and shareable links.
It ships as a **single self-contained HTML file served from ClickHouse itself**
(no Node server, no CDN, no runtime dependencies).

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
  [--audience <api-audience>] \
  [--cluster <cluster-name>]   # omit for single-node
```

The installer builds `dist/sql.html`, renders `config.json`, and uploads both
into ClickHouse `user_files/`. Then:

1. Add `deploy/http_handlers.xml` to the server's `config.d/` (or push it as an
   ACM cluster setting `config.d/sql-browser.xml`) and reload ClickHouse.
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
docs/         ARCHITECTURE.md, DEPLOYMENT.md, ASSET-DISTRIBUTION.md
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
