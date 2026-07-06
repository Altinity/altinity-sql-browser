# Altinity® SQL Browser

**🌐 Website & screenshots: [docs.altinity.com/altinity-sql-browser](https://docs.altinity.com/altinity-sql-browser/)**

An OAuth-gated **SQL browser for any ClickHouse® cluster** — schema explorer,
tabbed SQL editor with syntax highlighting, find/replace, bracket matching, and
schema-aware autocomplete, streaming results with table / JSON / chart views,
saved queries, history, and shareable links. It ships as a
**single self-contained HTML file served from ClickHouse itself** (no Node
server, no CDN, no external fonts) — the page makes **zero third-party
requests** and renders in the OS's native UI font. Its four bundled runtime
dependencies — **CodeMirror 6** (the SQL editor), **Chart.js** (the chart
result view), **@dagrejs/dagre** (the EXPLAIN pipeline-graph layout), and
**@preact/signals-core** (state reactivity) — are inlined into that one file.

Refactored from a single-file SPA into a fully modular, test-first codebase
held at **100% test coverage**.

## Demo & examples

See the [**feature tour, deployment guide and screenshots**](https://docs.altinity.com/altinity-sql-browser/)
on the project site. Try it live on the Antalya demo cluster: **https://antalya.demo.altinity.cloud/sql**.
The [**ontime chart demo**](docs/ONTIME-CHART-DEMO.md) is a ready-made library of 10
queries (load [`examples/ontime-charts.json`](examples/ontime-charts.json) via
**File ▾ → Open**) that walks through every chart type and feature against the public
`ontime` flight dataset. The [**system explorer demo**](docs/SYSTEM-EXPLORER-DEMO.md)
is a 14-query library (load [`examples/system-explorer-charts.json`](examples/system-explorer-charts.json)
via **File ▾ → Append**) that introspects ClickHouse's own `system` database —
running queries, merges/replication health, and historical query/part/error
activity — with a shared From/To filter driving every time-ranged Dashboard tile
at once.

## How it works

![Auth & data flow: the browser fetches the single-file SPA and its config.json from ClickHouse, signs in to your OAuth IdP with OAuth2 Authorization-Code + PKCE (id_token kept in sessionStorage), then POSTs every query to ClickHouse with an Authorization: Bearer id_token that ClickHouse validates against the IdP's JWKS via its token_processor (or a delegated verifier). There is no app-specific backend.](docs/assets/img/how-it-works.svg)

The browser never holds a static credential — each user authenticates with your
IdP and ClickHouse sees their JWT. There is **no app-specific backend**: the
only moving parts are ClickHouse's HTTP handlers and your OAuth provider.

## SQL editor

The editor is **CodeMirror 6** behind an injected `EditorPort` seam (#143/#21)
— bundled and inlined like the other runtime deps, so the page still makes
zero third-party requests. On top of it:

- **Per-tab undo** — each query tab keeps its own edit history; switching tabs
  parks and restores it.
- **Find / replace** — `Cmd/Ctrl+F` opens CM6's search panel (app-styled) with
  prev/next, case / whole-word / regex toggles, and replace.
- **Bracket matching + auto-close** — typing `(` `[` or a quote inserts the
  pair (or wraps the selection); typing a closer or quote steps over it;
  Backspace inside an empty pair deletes both; the pair adjacent to the caret
  is highlighted. Auto-close stays quiet inside strings and comments, and
  `{`/`}` is intentionally omitted — it would fight the `{name:Type}` query
  variables.
- **Autocomplete** — typing a word (or after `table.`) opens a ranked list of
  keywords, functions, databases, tables, and already-loaded columns —
  the candidate set and ranking are the app's own (`core/completions.js`),
  rendered through CM6's completion UI; ↑/↓/Enter/Tab/Esc and click to accept;
  functions insert `name()` with the caret between the parens, and the active
  row's description shows in an info tooltip.
- **Hover docs** — hovering a function or a ClickHouse keyword shows its
  signature/description from the same cached reference data —
  `system.functions.{syntax,description}` (loaded with #25) and a small
  built-in keyword-doc set — so they never query on the keystroke path.
  (In-call signature help was dropped in the CM6 parity cut; the reference
  docs pane (#60) rebuilds it properly.)
- **Drag to insert** — drag a schema table/column, or a **Library/History** row,
  onto the editor: a schema identifier drops as text at the drop point (the
  drop cursor tracks the pointer), and a saved/history query drops there as a
  `( … )` subquery (its trailing `FORMAT`/`;` stripped). Undoable;
  click-to-load still works for keyboard users.
  Dragging a **database or table onto the results pane** instead renders a
  [data flow graph](#data-flow-graph).
- **Query variables** — write a ClickHouse typed placeholder like
  `{database:String}` in a query and a strip below the toolbar shows an input for
  each detected variable; **Run stays disabled until they're all filled**. The
  values are sent as ClickHouse's native `param_<name>` arguments, so the server
  substitutes them per the declared type (injection-safe — `String`, `Identifier`,
  `DateTime`, `Array(…)`, `Map(…)` all work) and the SQL text is sent unchanged.
  Only row-returning statements are substituted, so a `CREATE VIEW … {x:String} …`
  definition is stored with its placeholder intact (a ClickHouse parameterized
  view). Run, `⌘↵`, Explain, and Export all honor it. Values are **remembered by
  variable name** — shared across every query and persisted across reloads — so a
  value typed once is prefilled wherever the same variable appears. (This is
  `{name:Type}` substitution, not the `{{name}}` composable-query macro.)

**The keystroke rule:** none of this runs SQL while you type. Reference data —
the server's keyword and function lists — is fetched **once per connection**
from `system.keywords` and `system.functions` (best-effort; it falls back to a
built-in set on older ClickHouse), cached in memory, and merged with the
in-memory schema. Highlighting then tracks the connected server's actual
keyword/function set — the lists feed a ClickHouse `SQLDialect` that is
reconfigured on connect — so it's version-correct.

> Design source of truth: the "Altinity Play" Claude Design project (external).
> Production is the vanilla ES-module code under `src/` — there is no React in
> the shipped app.

## Export

The **Export** button (editor toolbar, next to Share) runs the current editor
query **uncapped** and streams the result straight to a file you choose — it
never touches the result grid, so memory stays flat regardless of result size
(a multi-million-row export is fine). Under the hood: `fetch` streams
`resp.body` directly into a file opened via the browser's File System Access
API (`showSaveFilePicker`), so nothing is buffered in RAM at any point.

The output format follows the query: an explicit trailing `FORMAT <name>`
(before or after a `SETTINGS` clause — ClickHouse allows either order) streams
verbatim with a matching file extension (`.json`, `.csv`, `.parquet`, …);
otherwise it defaults to `TabSeparatedWithNames` (`.tsv`) — the cleanest for
opening in Excel or pandas. A small inline banner tracks progress (bytes
written, elapsed, **Cancel**); cancelling aborts the stream and issues its own
`KILL QUERY`, entirely independent of the grid's Run/Cancel.

A ClickHouse error **after** the response has already started streaming can't
change the HTTP status, so the server signals it in-band instead: an
`X-ClickHouse-Exception-Tag` header plus a trailing frame in the body (CH
≥ 24.11; older servers fall back to a plain-text scan). Export detects this,
holds back the last ~32 KiB of the stream until it can confirm the tail is
clean, and excises the exception frame before it ever reaches disk — so a
mid-stream failure is reported as "Export incomplete", never silently baked
into the file. A multi-statement (`;`-separated) script can't be exported in
one request (same reason EXPLAIN can't run one) — export a single statement at
a time.

Needs the File System Access API — see [Supported browsers](#supported-browsers)
for where that's available.

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

## Data flow graph

Drag a **database** or **table** row from the schema sidebar onto the results pane
to see how its ClickHouse objects relate — not generic foreign keys, but the
engine-specific data flow: materialized views (`feeds` from sources, `writes` to the
target), regular views (`reads` their sources), dictionaries (`dict` from a source
table), and `Distributed`/`Buffer`/`Merge` engines pointing at their backing
tables. Nodes are coloured by kind (table / view / materialized view / dictionary /
distributed / buffer / merge / external) with a legend; edges are coloured and
labelled by relationship. Drag a **database** → the whole-DB data flow (when there are
relationships it shows the tables that participate in them; a database with no
relationships at all still renders its tables as standalone nodes, so you always see
the objects); drag a **table** → its 1-hop neighbourhood. **Click any node** to run `SHOW CREATE` for it into the editor;
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

### Required grants

Every introspection read is **best-effort**: a denied or missing `system.*` table
degrades the affected layer instead of failing the graph, so the data-flow view works
even for low-privilege users. The graph draws with **no extra grants** — the implicit
`SELECT` that `SHOW TABLES` / `SHOW COLUMNS` give over `system.tables` /
`system.columns` is enough (and those rows are already filtered to the databases the
user can otherwise access). What you grant only buys *fidelity*:

| To get… | the role needs | if denied (default) |
|---|---|---|
| the graph itself + node cards | `SHOW TABLES`, `SHOW COLUMNS` (→ implicit `SELECT ON system.tables` / `system.columns`) | required — without these there's nothing to draw |
| dictionary (`dict`) data-flow edges | `SELECT ON system.dictionaries` | no dictionary edges; the rest of the graph still draws |
| skip-index badges on the rich cards | `SELECT ON system.data_skipping_indices` | cards show the engine/rows/bytes header without the skip line |
| per-partition rows in the node detail pane | `SELECT ON system.parts` | detail pane shows columns/keys/DDL but no partition breakdown |

So for full, **no-degrade** schema mode, grant the three optional `SELECT`s above to
the role your users log in as, e.g.:

```sql
GRANT SELECT ON system.dictionaries          TO <role>;
GRANT SELECT ON system.data_skipping_indices TO <role>;
GRANT SELECT ON system.parts                 TO <role>;
```

These are metadata-only and stay row-filtered to the databases the role can already
read; DDL secrets remain masked unless the role separately holds
`displaySecretsInShowAndSelect`.

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

### Run in Docker

The Docker image packages the existing zero-dependency Python runner, so the
container keeps the same behavior as the local app: it serves `/sql`,
generates `/config.json`, reads ClickHouse connections from
`~/.clickhouse-client`, and optionally probes which hosts are reachable.

```bash
docker compose up --build
```

Then open `http://localhost:8900/sql`.

By default `docker-compose.yaml` bind-mounts your host `~/.clickhouse-client` directory
into the container read-only and disables the startup reachability probe. That is
intentional: the probe runs inside the container, while the browser connects to
ClickHouse directly from your host, so host-only names like `localhost` or
entries resolved via your host `/etc/hosts` can be valid in the browser but fail
when probed from Docker. Useful overrides:

```bash
SQL_BROWSER_PROBE=1 docker compose up --build   # re-enable container-side /ping checks
PORT=9000 docker compose up --build             # publish on another local port
```

You can also build and run the image directly:

```bash
docker build -t altinity-sql-browser:local .
docker run --rm -p 8900:8900 \
  -v "$HOME/.clickhouse-client:/home/asb/.clickhouse-client:ro" \
  altinity-sql-browser:local
```

### Run locally against your own ClickHouse

**Install (no clone, no Node — just `python3`):**

```bash
curl -fsSL https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/install.sh | sh
altinity-sql-browser          # serve → open http://localhost:8900/sql
```

This downloads the latest [release](https://github.com/Altinity/altinity-sql-browser/releases)
bundle (the prebuilt single-file SPA + the zero-dependency Python runner) into
`~/.altinity-sql-browser` and installs a launcher in `~/.local/bin`. Overrides:
`ASB_VERSION` (tag to install), `ASB_HOME`, `ASB_BIN`.

The installer also writes a sample **`~/.clickhouse-client/sql-browser.xml`** (a few
public demo clusters) — under a separate name, so it **never replaces your real
`config.xml`**. The runner **merges** connections from both files (your `config.xml`
wins on a name clash), so a fresh machine has something to connect to immediately.
The picker uses `<http_port>` if set; otherwise, since a cluster may serve the
HTTP interface on either port, at startup the runner **probes both standard ports**
(`443` then `8443` for secure, `8123` then `80` for plain) and uses whichever
answers `Ok.` on `/ping`. The native `<port>` (9440/9000) is never used — it's a
different interface. The probe **prints a reachability table** and skips any host
with no HTTP interface on any port (e.g. a native-only endpoint) so it isn't a dead
pick. Set `SQL_BROWSER_PROBE=0` to skip probing and keep all hosts (`8443`/`8123`).

**From a checkout** (also builds the SPA, needs Node):

```bash
npm run local          # build + serve → open http://localhost:8900/sql
```

The app is a thin client — queries go straight from the browser to the chosen
ClickHouse — so the local server only serves the page plus a generated
`config.json`. It reads your **`~/.clickhouse-client/config.xml`** connections and
offers them as a **Saved connection** dropdown on the login screen, or you can
ignore the picker and type a host/user/password by hand (host: include the
scheme, e.g. `http://localhost:8123`; a bare host defaults to
`https://<host>:8443`). See
[docs/LOGIN-SCREEN.md](docs/LOGIN-SCREEN.md#the-saved-connection-picker-multi-host)
for exactly how the picker and manual host entry behave (including the
insecure-certificate flow).

The target ClickHouse must allow cross-origin requests — ClickHouse's HTTP
interface sends `Access-Control-Allow-Origin` for requests with an `Origin` header
by default, so a stock server works. For an **OAuth** connection you also register
`http://localhost:8900/sql` as a redirect URI with the IdP. Override the serve port
with `PORT` and the config path with `LOCAL_CH_CONFIG`. Ctrl-C stops it.

**From Docker** (no Node on the host, same runner behavior):

```bash
docker compose up --build
```

The container exposes `http://localhost:8900/sql` and reads saved connections
from a read-only mount of `~/.clickhouse-client` into `/home/asb/.clickhouse-client`.
Docker Compose disables `SQL_BROWSER_PROBE` by default because the probe runs in
the container and may incorrectly drop host-only aliases such as `localhost` or
names resolved through your host `/etc/hosts`. Re-enable it with
`SQL_BROWSER_PROBE=1` if your saved hosts are reachable from inside Docker too.

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
   The SPA handler serves both `/sql` (the workbench) and `/sql/dashboard` (the
   favorites dashboard) from the same file.
2. Register the redirect URI `https://<ch-host>/sql` with your OAuth IdP. If users
   will open `/sql/dashboard` via a cold/bookmarked link (rather than from the app,
   which hands credentials over in-session), also register
   `https://<ch-host>/sql/dashboard` so that direct sign-in can complete.
3. Make sure ClickHouse accepts the bearer JWT — either a CH
   `<token_processors>` entry validating your IdP's JWKS, or a delegated
   `<http_authentication_servers>` verifier. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Configuring the login screen

`config.json` controls everything about the sign-in screen: which OAuth
provider(s) to offer, whether the username/password path shows at all, and how
the "connect to another server" picker behaves. Full reference:
**[docs/LOGIN-SCREEN.md](docs/LOGIN-SCREEN.md)** — covers configuring OAuth
(single or multiple IdPs), hiding/keeping the credentials (username/password)
path, and the host/Advanced/saved-connection picker.

### Security headers

> For the vulnerability-disclosure policy and the full threat model (why
> `config.json` is public, the redirect-lock requirement, token storage), see
> [`SECURITY.md`](SECURITY.md).

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
             stream, storage, chart-data, completions (editor reference data
             + ranking) — no DOM, no globals
  net/       oauth-config, oauth, ch-client (injected fetch seam)
  editor/    the EditorPort seam (editor-port) + its CodeMirror 6 adapter
             (codemirror-adapter) — injected via createApp(env)
  ui/        dom (hyperscript), icons, + render modules (login, tabs, schema,
             results, saved-history, shortcuts, splitters, toast, app)
  state.js   state model + pure operations
  main.js    bootstrap (OAuth callback, share-links, initial render)
  styles.css
build/        esbuild → single-file dist/sql.html
deploy/       install.sh, uninstall.sh, http_handlers.xml, config.json.example
deploy/k8s/   sample Deployment, Service, ConfigMap, Ingress example
tests/        vitest + happy-dom, one spec per module
docs/         ARCHITECTURE.md, DEPLOYMENT.md, ASSET-DISTRIBUTION.md,
              CLICKHOUSE-OAUTH.md, CLICKHOUSE-OSS-OAUTH.md
```

## Supported browsers

Current **desktop** engines — Chromium (Chrome/Edge), Firefox, and **Safari
(WebKit)** — are all supported. The whole layout and the pointer/caret/drag math
ride on `html { zoom: var(--zoom) }`. The pointer/caret/drag corrections
self-calibrate (they divide by the live `getBoundingClientRect`/`offsetWidth`
ratio — the zoom factor on Chromium, `1` on Safari — both correct), so those work
across engines.

Engines do diverge on one thing — **viewport units under `zoom`**: Chromium's
`vw`/`vh` ignore it, Safari's track it. The fullscreen graph panels size off
`vw`/`vh`, so the divisor they apply is **measured at runtime** and published as
`--vp-zoom` (~`--zoom` on Chromium, ~`1` on Safari), letting them fit one screen
on both (#70). An engine that can't parse `zoom` at all falls back via
`@supports not (zoom: 1)` to a consistent 1× layout.

CI exercises the editor (CM6 behaviors + insertion paths), schema-graph and
EXPLAIN-pipeline specs on all three engines (`webkit` added in #69), plus a
panel-sizing spec. **Caveat:** Playwright's WebKit applies `zoom` to
`getBoundingClientRect`/viewport units like Chromium, *not* like real Safari, so
it is not a faithful Safari proxy for that specific behavior — the real-Safari
viewport-unit path is verified manually (tracked in the #71 matrix).

> The app targets **desktop** browsers, plus a **best-effort mobile mode**
> (#126): below a 768px viewport the shell becomes a bottom-tab-nav workbench — a
> bottom bar switches between three full-screen panels (**Tables / Editor /
> Results**), with a Schema|Library toggle in Tables and a row-count badge on
> Results, and it auto-navigates (tap a column → Editor, Run → Results). The core
> SQL loop (tap to browse the schema, write, run, read results, chart, and 4 of
> the 5 EXPLAIN views) is fully usable on a phone. Pointer-only extras (resizing,
> native drag-and-drop, hover tooltips, the Pipeline graph) are hidden rather
> than left half-working on touch. The formal narrow-viewport stance is part of
> the matrix in #71.

The full system-requirements matrix — minimum browser versions, supported
ClickHouse server versions, and IdP/OAuth requirements — is tracked in #71.

One feature is narrower than the rest of the app: [**Export**](#export) needs
the File System Access API, which today is **Chromium-only** (Chrome/Edge) over
HTTPS or `localhost`. On Firefox, Safari, or plain HTTP, the Export button stays
visible but disabled with a tooltip explaining why — no other feature is
affected.

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

happy-dom has no real layout or scrollbars, so render-layer bugs (keyboard
routing through the real engine, completion popup timing, drop-point geometry)
can't be caught by the unit suite. A small Playwright harness mounts the real
`src/` modules in **Chromium, Firefox and WebKit** for those cases — WebKit is the Safari proxy and the engine most likely to diverge
on the `html{zoom}`-based layout (see [Supported browsers](#supported-browsers)).

```bash
npx playwright install chromium firefox webkit   # once per machine
npm run test:e2e
```

The harness (`tests/e2e/`) serves the repo over HTTP and imports the actual
source as native ESM — no bundling, always current. It is **not** part of
`npm test` or the coverage gate.

## Releasing

Releases are cut by pushing a version tag — `.github/workflows/release.yml` then
runs the coverage gate, assembles the bundle, and publishes a GitHub Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release attaches `altinity-sql-browser.tar.gz` (+ `.sha256`) and the raw
`sql.html`. The bundle is built by `build/bundle.sh` (also runnable locally), and
every PR smoke-tests it in CI (`bundle` job: extract → boot the runner → fetch
`/sql` + `/config.json`). The `curl | sh` `install.sh` resolves the latest tag and
installs that artifact.

## License

Apache-2.0.
