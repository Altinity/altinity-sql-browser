# Altinity SQL Browser

An OAuth-gated **SQL browser for any ClickHouse cluster** — schema explorer,
tabbed SQL editor with syntax highlighting, find/replace, bracket matching, and
schema-aware autocomplete, streaming results with table / JSON / chart views,
saved queries, history, and shareable links. It ships as a
**single self-contained HTML file served from ClickHouse itself** (no Node
server, no CDN, no external fonts) — the page makes **zero third-party
requests** and renders in the OS's native UI font. Its two bundled runtime
dependencies — **Chart.js** (the chart result view) and **@dagrejs/dagre** (the
EXPLAIN pipeline-graph layout) — are inlined into that one file.

Refactored from a single-file SPA into a fully modular, test-first codebase
held at **100% test coverage**.

## Demo & examples

Try it live on the Antalya demo cluster: **https://antalya.demo.altinity.cloud/sql**.
The [**ontime chart demo**](docs/ONTIME-CHART-DEMO.md) is a ready-made library of 10
queries (load [`examples/ontime-charts.json`](examples/ontime-charts.json) via
**File ▾ → Open**) that walks through every chart type and feature against the public
`ontime` flight dataset.

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

## SQL editor

The editor is a hand-rolled `<textarea>` over a syntax-highlighted `<pre>` (no
editor library — it adds nothing to the single served file). On top of that:

- **Find / replace** — `Cmd/Ctrl+F` opens a panel with a live match count,
  prev/next (Enter / Shift+Enter), case / whole-word / regex toggles, and a
  replace row. Matches highlight via a transparent overlay layered below the
  syntax tokens, so highlighting and search never interfere.
- **Bracket matching + auto-close** — typing `(` `[` or a quote inserts the
  pair (or wraps the selection); typing a closer or quote steps over it;
  Backspace inside an empty pair deletes both. The pair adjacent to the caret
  is highlighted. (`{`/`}` auto-close is intentionally omitted.)
- **Autocomplete** — typing a word (or after `table.`) opens a ranked dropdown
  of keywords, functions, databases, tables, and already-loaded columns;
  ↑/↓/Enter/Tab/Esc and click to accept; functions insert `name(`.
- **Signature help + hover docs** — inside a function call, a popover shows the
  signature with the active argument bolded; hovering a function or a
  ClickHouse keyword shows its signature/description. Both read the same cached
  reference data — `system.functions.{syntax,description}` (loaded with #25) and
  a small built-in keyword-doc set — so they never query on the keystroke path.
- **Drag to insert** — drag a schema table/column, or a **Library/History** row,
  onto the editor: a schema identifier drops as text at the caret, and a
  saved/history query drops as a `( … )` subquery at the drop point (its trailing
  `FORMAT`/`;` stripped). Undoable; click-to-load still works for keyboard users.
  Dragging a **database or table onto the results pane** instead renders a
  [schema lineage graph](#schema-lineage-graph).

**The keystroke rule:** none of this runs SQL while you type. Reference data —
the server's keyword and function lists — is fetched **once per connection**
from `system.keywords` and `system.functions` (best-effort; it falls back to a
built-in set on older ClickHouse), cached in memory, and merged with the
in-memory schema. Highlighting then tracks the connected server's actual
keyword/function set, so it's version-correct. Folding and multi-cursor are out
of scope for a textarea and tracked separately (CodeMirror, issue #21).

> Design source of truth: the handoff bundle under `design/` (imported from the
> "Altinity Play" Claude Design project) — read `design/README.md` before UI
> work. The `.jsx` files there are React prototypes; production is the vanilla
> ES-module code under `src/`.

## EXPLAIN views

Run an `EXPLAIN` (or click **Explain** in the editor toolbar to explain the
current query without editing it) and the results pane offers five views of the
plan — switching one re-runs the query in that form; **the editor SQL is never
rewritten**:

- **Explain** — your `EXPLAIN` run *verbatim*, so any parameters you typed
  (`EXPLAIN indexes=1, actions=1, json=1 …`) are honored. Shown as plan text.
- **Indexes** / **Projections** — `EXPLAIN indexes = 1` / `projections = 1` of the
  inner query (used parts/granules, analyzed projections). Plan text.
- **Pipeline** — `EXPLAIN PIPELINE graph = 1`, whose Graphviz DOT is drawn as a
  boxes-and-arrows processor graph (with a fullscreen pan/zoom view). The DOT parse
  is pure in `src/core/dot.js`; node/edge layout is delegated to **dagre** through
  an injected seam (`src/core/dot-layout.js`), and our own SVG renderer draws it.
- **Estimate** — `EXPLAIN ESTIMATE`, rendered as a real table (database, table,
  parts, rows, marks).

Running a statement that *exactly* matches one of the rich forms auto-selects its
tab (e.g. `EXPLAIN ESTIMATE …` opens **Estimate**); anything else opens the
verbatim **Explain** tab. An explicit `… FORMAT <name>` on an EXPLAIN bypasses the
views and shows ClickHouse's raw response.

## Schema lineage graph

Drag a **database** or **table** row from the schema sidebar onto the results pane
to see how its ClickHouse objects relate — not generic foreign keys, but the
engine-specific lineage: materialized views (`feeds` from sources, `writes` to the
target), regular views (`reads` their sources), dictionaries (`dict` from a source
table), and `Distributed`/`Buffer`/`Merge` engines pointing at their backing
tables. Nodes are coloured by kind (table / view / materialized view / dictionary /
distributed / buffer / merge / external) with a legend; edges are coloured and
labelled by relationship. Drag a **database** → the whole-DB lineage (it shows only
the tables that participate in a relationship; a database whose tables aren't linked
by any view/MV/dictionary/Distributed engine shows a "no object relationships"
message rather than a wall of disconnected boxes); drag a **table** → its 1-hop
neighbourhood. **Click any node** to run `SHOW CREATE` for it into the editor;
**⌘/Ctrl-drag** to pan; **Expand** for the full view.

The full view opens in a **real browser tab** kept live by the opener (it still
holds the OAuth token, so click-to-detail fetches on demand) — keep the tab open
beside the editor. If a pop-up is blocked it falls back to an in-app overlay. Three
cursor shapes keep the actions distinct: a **pointer** over a card (**click** opens a
detail pane — full columns / keys / partitions / DDL), the **move ✛** cursor when
**⌘/Ctrl** is held over a card (**⌘/Ctrl-drag to move it**, its edges re-route as
straight lines), and the **grab hand** over empty canvas (plain **drag pans**). Wheel
pans, ⌘/Ctrl+wheel zooms, double-click fits, **Esc** closes the detail pane.
Node moves are **undo/redo-able** (⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z or ⌘/Ctrl+Y), and
manually-moved positions persist for as long as that result is open.

Discovery is **structured-first, parse-fallback**, because the helpful
`system.tables` columns are build-dependent: it prefers `dependencies_table` /
`loading_dependencies_*` / `system.dictionaries.source` when populated, and
otherwise lets ClickHouse parse the SQL via **`EXPLAIN AST`** (for query sources)
plus light regex on `create_table_query` (`TO` target) and `engine_full`
(Distributed/Buffer/Merge args). This keeps it working on older deployed builds
(e.g. Altinity-antalya 26.3, where `target_*` is absent and `dependencies_*` can be
empty). Graph math is pure in `src/core/schema-graph.js` (100%-covered); the SVG is
the same dagre-laid-out renderer the pipeline graph uses.

## Saved queries & the Library

Queries you save (★ **Save** next to Run, or `⌘S`) land in the sidebar **★ Library**
panel. Each carries a name, an optional **description**, and — when set — its
remembered result view and chart config. Saving or editing a query opens a small
form with both a name and a description field; the description shows under the
row and is included in Markdown/SQL exports.

The whole collection is treated as a **document — the Library** — with a name and
an unsaved-changes dot, managed from the header **File ▾** menu:

- **New Library** — clears to an empty, default-named library (confirms first
  when non-empty). Open editor tabs are unaffected.
- **Save JSON** (`.json`) — downloads the whole Library in the versioned
  `altinity-sql-browser/saved-queries` envelope (lossless: keeps id, name,
  description, sql, favorite, chart, view). The filename derives from the Library
  name; saving clears the unsaved-changes dot.
- **Open… / Append…** — load a `.json` file: Open swaps the Library and
  adopts the file's base name (confirms when the current Library is non-empty);
  Append merges via the existing dedupe and reports `Added N · updated N ·
  skipped N`. **JSON is the only importable format**, and imported SQL is never
  run automatically.
- **Share / publish** — **Download Markdown** (`.md`, a `### heading` + fenced
  ` ```sql ` cookbook) and **Download SQL** (`.sql`, `/* name + description */`
  comment blocks, `;`-delimited). Both are **one-way** — lossy by design (no ids,
  chart, or view), so JSON stays the canonical round-trip format.

The Library name is editable inline (click it in the header) and is persisted
separately from the queries. The **•** dot appears after any change that hasn't
been written to a file yet (save/rename/delete/favorite/append/rename) and clears
on Save JSON / Open / New.

## Quick start (development)

```bash
npm install            # esbuild ships platform-specific binaries; use install, not ci
npm test               # vitest + 100% coverage gate
npm run build          # → dist/sql.html (single file)
npm run dev            # build + serve dist/ at http://localhost:8900
```

### Run locally against your own ClickHouse

`npm run local` builds the SPA and serves it as a static page on localhost:

```bash
npm run local          # build + serve → open http://localhost:8900/sql
```

The app is a thin client — queries go straight from the browser to the chosen
ClickHouse — so the local server only serves the page plus a generated
`config.json`. It reads your **`~/.clickhouse-client/config.xml`** connections and
offers them as a **Saved connection** dropdown on the login screen:

- A plain connection (`hostname`/`user`/`password`) → prefills the credentials
  form (cross-origin HTTP Basic to that host).
- A connection carrying clickhouse-client's OAuth keys (`oauth-url`,
  `oauth-client-id`, `oauth-audience`) → an OAuth sign-in against that cluster.

You can also ignore the picker and type a host/user/password by hand (host: include
the scheme, e.g. `http://localhost:8123`; a bare host defaults to
`https://<host>:8443`).

The target ClickHouse must allow cross-origin requests — ClickHouse's HTTP
interface sends `Access-Control-Allow-Origin` for requests with an `Origin` header
by default, so a stock server works. For an **OAuth** connection you also register
`http://localhost:8900/sql` as a redirect URI with the IdP. Override the serve port
with `PORT` and the config path with `LOCAL_CH_CONFIG`. Ctrl-C stops it.

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

### Credentials login (username / password)

Alongside SSO, the sign-in screen offers a **ClickHouse username + password**
path (HTTP Basic), shown by default.

**Hide it (SSO-only).** If the cluster has no password-authenticated CH users —
e.g. it only accepts JWTs via a `token_processor`/verifier — the credentials path
would just 401, so set top-level `"basic_login": false` to drop it and offer SSO
only:

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

Credentials authenticate against the **serving host** by default. The login
screen's **Advanced → Server address** field can aim the credential path at a
**different** `host:port` (a bare host defaults to `https://…:8443`); SSO always
stays on the serving host. You can pre-fill that field with a **`?host=` URL
param** — e.g. `…/sql?host=other.example:9000` opens Advanced with the address
filled in and **disables the SSO buttons** (SSO can only target the serving
host), so the link drops you straight into credential sign-in for that server.
The same-origin path needs no extra setup, but a
**cross-origin** target has two requirements:

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
             stream, storage, chart-data, and the editor logic: completions
             (reference data + ranking), editor-search (find), editor-brackets
             (match/auto-close), editor-marks (overlay), editor-geometry
             (caret) — no DOM, no globals
  net/       oauth-config, oauth, ch-client (injected fetch seam)
  ui/        dom (hyperscript), icons, + render modules (login, editor +
             editor-search/editor-complete, tabs, schema, results,
             saved-history, shortcuts, splitters, toast, app)
  state.js   state model + pure operations
  main.js    bootstrap (OAuth callback, share-links, initial render)
  styles.css
build/        esbuild → single-file dist/sql.html
deploy/       install.sh, uninstall.sh, http_handlers.xml, config.json.example
design/       imported design handoff bundle (UI spec; reference only, not built)
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

### End-to-end (real browser)

happy-dom has no real layout or scrollbars, so render-layer bugs (e.g. the
editor highlight drifting behind the selection when a scrollbar shrinks the
textarea's client box) can't be caught by the unit suite. A small Playwright
harness mounts the real `src/` modules in Chromium for those cases.

```bash
npx playwright install chromium   # once per machine
npm run test:e2e
```

The harness (`tests/e2e/`) serves the repo over HTTP and imports the actual
source as native ESM — no bundling, always current. It is **not** part of
`npm test` or the coverage gate.

## License

Apache-2.0.
