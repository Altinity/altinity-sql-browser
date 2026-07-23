# Altinity® SQL Browser

**🌐 Website & screenshots: [docs.altinity.com/altinity-sql-browser](https://docs.altinity.com/altinity-sql-browser/)**

An OAuth-gated **SQL browser for any ClickHouse® cluster** — schema explorer,
tabbed SQL editor with syntax highlighting, find/replace, bracket matching, and
schema-aware autocomplete, streaming results with table / JSON / chart views,
saved queries, history, and shareable links. It ships as a
**single self-contained HTML file served from ClickHouse itself** (no Node
server, no CDN, no external fonts) — every runtime dependency is bundled, and
the page renders in the OS's native UI font. Its seven bundled runtime
dependencies — **CodeMirror 6** (the SQL editor, saved-query Spec JSON editor,
and read-only source viewer),
**Chart.js** + **chartjs-adapter-date-fns** + **date-fns** (the chart result
view, including a real time scale for time-series line/area charts),
**@dagrejs/dagre** (the
EXPLAIN pipeline-graph layout), and
**@preact/signals-core** (state reactivity), and **marked** (Markdown
tokenization for reference documentation) — are inlined into that one file.

Refactored from a single-file SPA into a fully modular, test-first codebase
held at **100% test coverage**.

## Demo & examples

See the [**feature tour, deployment guide and screenshots**](https://docs.altinity.com/altinity-sql-browser/)
on the project site. Try it live on the Antalya demo cluster: **https://antalya.demo.altinity.cloud/sql**.
Three flagship bundles cover the main workflows without a pile of one-feature
fixtures:

- [**On-time flights**](docs/ONTIME-CHART-DEMO.md) — seven analytical tiles,
  a KPI band, a shared 2023 date range, and carrier/airport multiselects over
  the public `ontime` dataset.
- [**Shop analytics**](docs/SHOP-ANALYTICS-DEMO.md) — seven business tiles over
  the schema, sample data, materialized views, and dictionary created by
  [`examples/shop-demo.sql`](examples/shop-demo.sql).
- [**ClickHouse Operations**](docs/CLICKHOUSE-OPERATIONS-DEMO.md) — sixteen
  operator-first tiles for live health, resources, background work, and
  investigation, with the remaining operational queries kept in the Library.

Load the corresponding portable bundle from `examples/` with **File ▾ → Open…**.
The [**Iceberg catalog explorer**](docs/ICEBERG-CATALOG-EXPLORER-DEMO.md) is a
distributable installer + two dashboards for Iceberg data-lake catalogs:
[`examples/iceberg-install.json`](examples/iceberg-install.json) generates the
`ice_meta_<catalog>` navigation views (per catalog, plus a cross-catalog union
layer) straight from filter inputs, and
[`examples/iceberg-catalog-dashboard.json`](examples/iceberg-catalog-dashboard.json) (BI) /
[`examples/iceberg-dba-dashboard.json`](examples/iceberg-dba-dashboard.json) (DBA,
with snapshot/metadata **log panels**) explore them with one shared `catalog`
filter across every tile.

## How it works

![Auth & data flow: the browser fetches the single-file SPA and its config.json from ClickHouse, signs in to your OAuth IdP with OAuth2 Authorization-Code + PKCE (id_token kept in sessionStorage), then POSTs every query to ClickHouse with an Authorization: Bearer id_token that ClickHouse validates against the IdP's JWKS via its token_processor (or a delegated verifier). There is no app-specific backend.](docs/assets/img/how-it-works.svg)

The browser never holds a static credential — each user authenticates with your
IdP and ClickHouse sees their JWT. There is **no app-specific backend**: the
only moving parts are ClickHouse's HTTP handlers and your OAuth provider.

## SQL and Spec editors

The workbench uses **CodeMirror 6** behind separately injected SQL and Spec
editor seams (#143/#21/#212) — bundled and inlined like the other runtime deps,
so no editor library is loaded from a third-party CDN. A saved-query tab exposes a
visible **SQL | Spec** switch: SQL edits the executable text, while Spec edits
only the complete `query.spec` JSON. Linked Save validates and atomically
commits both drafts; an unsaved tab remains SQL-only until its first Save.

Spec mode provides JSON highlighting, line numbers, bracket matching, folding,
local search, undoable two-space formatting, and continuous path-addressed parse
and semantic diagnostics backed by the canonical Draft 2020-12
[`query.spec` schema](schemas/query-spec-v1.schema.json). The
same canonical schema drives native CodeMirror autocomplete for root and nested
keys, panel variants, finite/default/example values, safe object/array
skeletons, and schema-owned snippets. Annotated positions also offer cached
columns from the active tab's last successful result; completion never runs a
query. The popup opens while typing or with **Ctrl-Space**; arrows navigate,
**Enter** or **Tab** accepts, **Escape** closes it, and Tab inserts two spaces
when the popup is closed. Only blocking errors appear in the bottom Spec status
strip—warnings and information remain non-blocking and a valid Spec shows no
success footer. The
[schema-service notes](docs/drafts/saved-query-spec-json-schema.md) and
[visualization authoring guide](docs/drafts/visualization-spec-authoring-guide.md)
document the reusable validation and panel contracts. The
[complete Library schema guide](docs/library-json-schema.md) documents the
saved-query and Library envelopes plus the offline schema bundle. Its toolbar is deliberately small: **Format**,
**Save**, and the **SQL | Spec** switch. Blocking errors disable Save and are
never persisted; unknown fields remain valid and survive Save.

The implemented **KPI** panel turns an exactly-one-row result into responsive
cards: numeric scalar columns become simple KPIs, while named ClickHouse
`Tuple(value numeric, delta Nullable(numeric))` columns add an optional delta.
SQL owns the values; `panel.fieldConfig` owns labels, descriptions, units,
rounding, colors, NULL text, visibility, and delta semantics. The card
rendering itself — labels, values, deltas, colors — is identical on both
surfaces; the surrounding composition differs by design (#240): the workbench
Panel preview and an unconfigured Dashboard KPI tile show the cards inside the
ordinary `.kpi-panel` grid, while a **favorited, explicitly-KPI-typed** Dashboard
query instead joins a full-width **KPI band** — a flat, wrapping card stream
with no per-favorite name, description, or statistics footer, spanning every
flow Dashboard layout (Report/2/3 columns). Consecutive explicit KPI
favorites merge into one shared band. The On-time, Shop, and Operations
flagship dashboards all include a production
KPI band alongside charts, tables, and logs.
When constructing a named tuple from expressions, either enable alias-derived
member names for the query:

```sql
SELECT (99.95 AS value, 0.08 AS delta) AS availability
SETTINGS enable_named_columns_in_function_tuple = 1
```

or cast an ordinary tuple to an explicitly named type:

```sql
SELECT CAST(
  (99.95, 0.08),
  'Tuple(value Float64, delta Float64)'
) AS availability
```

Without the setting or cast, ClickHouse reports `Tuple(Float64, Float64)`,
which is positional and intentionally ineligible for KPI value/delta roles.

Panel controls and Library favorite/pencil edits merge their fields into valid
open Spec drafts, preserving unrelated unsaved and extension fields. Syntax or
schema/feature errors block the staged writer before any draft or Library entry
is changed; invalid JSON focuses the affected Spec tab with a
**Fix Spec JSON first** message. Run,
Explain, SQL formatting, Export, and Share are SQL-mode actions; switch back to
SQL to use them.

The same bundled CodeMirror presentation/search base also powers an injected
read-only `CodeViewer` seam (#213) for source surfaces. It supports complete
text, JSON, SQL, XML/HTML-source, and plain Markdown-source documents with line
numbers, local search, selection/copy, configurable wrapping, detached-document
mounting, and explicit teardown—without inheriting editor history, completion,
schema, drag/drop, or app-state behavior.

The SQL editor provides:

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
- **Optional filter blocks** — an empty filter can also mean "no filter": wrap
  a predicate in a comment-marked block and it is included only while every
  parameter inside it has a value:

  ```sql
  SELECT * FROM events
  WHERE tenant_id = {tenant_id:UInt64}
  /*[ AND d = {d:String} ]*/
  ```

  Here `tenant_id` stays required, while a blank `d` simply removes the whole
  `AND d = …` predicate before the query is sent (typing a value puts it back
  and re-binds `param_d`; parameters of an omitted block are never sent). The
  strip marks a **required** parameter's name with a leading `*` (`name*:`) —
  a block-only parameter stays optional (`name:`, muted) and the Dashboard
  filter bar behaves the same way — a blank optional filter runs the tile
  unfiltered instead of blocking it. Values are never interpolated into the
  SQL: the materialized query still carries `{name:Type}` placeholders and
  ClickHouse does the typed substitution. The syntax is **SQL-transparent**: to
  any tool that doesn't know the convention (an external client, server-side
  `formatQuery()`, a code review) each block is an ordinary comment, so the raw
  template parses and runs anywhere — with all filters inactive, which is
  exactly the intended default. Limitations (each rejected with a clear error,
  never silently mangled): blocks don't nest, must contain at least one
  parameter, and can't hold a `;` or a whole statement; block content can never
  contain `*/` in any form — not even inside a string literal, where
  ClickHouse's comment lexer would still end the comment early (an in-string
  `*/` or `]*/` is reported as "content ends inside a string literal").
  Non-row-returning statements (DDL, parameterized views) are never
  materialized. Because
  server-side `formatQuery()` would strip the markers, **Format skips a
  statement containing optional blocks** (with a notice) and formats the rest
  of the script normally.
- **Relative time expressions** — a variable declared with a date/time type
  (`Date`, `Date32`, `DateTime`, `DateTime64(N)`, any `Nullable(…)` of those)
  accepts a relative expression instead of an absolute value — `-1h`,
  `now-7d`, `now/d` — so a "last hour of logs" or "yesterday's traffic" query
  keeps a **moving window**: the stored value is the expression, and it
  re-resolves against "now" every time it runs (workbench Run, Dashboard
  load/Refresh, a filter-change wave) rather than freezing at the moment it
  was typed. Grammar (Grafana's, adopted verbatim — case-sensitive units):

  ```text
  expr := 'now' [sign amount unit] [rounding]
        | sign amount unit [rounding]        -- shorthand: '-1h' ≡ 'now-1h'
  sign := '-' | '+'
  unit := s | m | h | d | w | M | y          -- m = minute, M = month
  rounding := '/' unit                        -- always snaps DOWN, after the offset
  ```

  | Input | Meaning |
  |---|---|
  | `now` | current instant |
  | `-1h` | one hour ago (`now-1h`) |
  | `-30s`, `-15m`, `-1d`, `-1w`, `-1M`, `-1y` | an offset in each unit |
  | `now/d` | start of today |
  | `-1d/d` | start of yesterday |
  | `now/w` | start of this week (ISO-8601 — Monday) |
  | `now/M` | start of this month |
  | `now-1h/h` | start of the hour, one hour ago (offset first, then round) |

  `s`/`m`/`h` offsets are **fixed durations** (exact elapsed time); `d`/`w`/`M`/`y`
  offsets and all `/u` rounding are **calendar arithmetic in your local
  timezone** — `-1d` means "the same wall-clock time yesterday" even across a
  23/25-hour DST transition day, and month/year offsets clamp to the target
  month's last day (`Mar 31` `-1M` → `Feb 28`/`29`). An absolute value keeps
  working unchanged; a string that merely *looks* relative (starts `now…`, or
  a sign followed by digits) but doesn't fully parse is rejected inline,
  never sent. Values still travel as native `param_<name>` arguments — never
  interpolated — formatted per the declared type: `Date`/`Date32` as a local
  calendar date, `DateTime` as integer epoch seconds, `DateTime64(N)` as epoch
  seconds with an `N`-digit fraction.

  The field gets a **preset dropdown** on focus (type-to-filter; click
  inserts the expression — the field stays free-text, so an absolute
  timestamp still works) and a **live preview** of the resolved instant next
  to it, e.g. `2026-07-11 13:23:45` (the expression itself is already visible
  in the input, so the preview shows only the calculated timestamp). That
  preview always renders in **UTC ("server time")**, never converted to the
  viewer's local zone — the same instant then reads identically for every
  viewer regardless of where they are, matching how a `DateTime` column with
  no explicit timezone argument displays on the server. The trade-off this
  implies: "now" is the **client's** clock, which can skew from the server's
  `now()` — the same trade-off Grafana makes, accepted rather than
  compensated for.
- **Recent values** — every `{name:Type}` field also remembers the **10 most
  recently used** values per variable name, offered in a dropdown on focus
  (type-to-filter; click inserts, Esc/blur closes, the field stays free-text).
  A value is recorded only when a statement or dashboard tile **completes
  successfully** — never on a keystroke, never from a failed statement — and
  only the params that were actually sent (a param confined to an inactive
  optional filter block, or left blank, is never recorded). For a relative
  time expression the **typed expression** is remembered (`-1h`), not the
  resolved instant, so it keeps re-resolving on reuse; a date-like field's
  dropdown combines its presets and recents in one list. History is
  name-keyed and shared across every query/tab/dashboard exactly like
  `varValues` — persisted in the browser's `localStorage`, so it is
  **plaintext, same exposure as `varValues`**: don't put secrets in a
  variable's value. "Clear recent" (per field) and "Clear all recent
  values" + a "Remember recent variable values" toggle live in the header
  **File** menu.
- **Enum-valued dropdown** — a variable declared `{name:Enum8(…)}` /
  `Enum16(…)` gets a dropdown of its member names, parsed straight out of the
  declaration (type-to-filter; click inserts). A **bare** `{o:Enum}` /
  `{o:Enum8}` / `{o:Enum16}` — no member list in the braces — is **not** a
  valid ClickHouse parameter type: the server rejects it outright with
  `Enum data type cannot be empty` (verified live on 26.3.13), so there's no
  way to get the dropdown by declaring an empty Enum and letting the workbench
  fill in the members. Two ways to actually get it: paste the **full**
  `Enum8('a'=1,'b'=2,…)` type into the declaration for a real, blocking
  validation (a non-member value is rejected on both the workbench and the
  Dashboard filter bar); or, workbench only, declare the variable as
  `{o:String}` and compare it directly to the Enum column
  (`WHERE operation = {o:String}`) — the dropdown is then inferred from that
  column's *cached* schema type, offered purely as a **suggestion**: the
  declared type stays `String`, so a value that isn't a member still runs.

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
| the data-skipping-index section in the node detail pane | `SELECT ON system.data_skipping_indices` | detail pane shows columns/keys/partitions/DDL but no index section |
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

Queries you save (★ **Save** next to Run, or `⌘S`) land in the sidebar **★ Queries**
panel. Each carries a name, an optional **description**, and — when set — its
remembered result view and chart config. Saving or editing a query opens a small
form with both a name and a description field; the description shows under the
row and is included in Markdown/SQL exports.

The queries plus the zero-or-one editable Dashboard form a workspace
(`StoredWorkspaceV2`). A browser profile can keep multiple workspaces in
IndexedDB; each has an immutable opaque id, a stable human-readable URL key,
and a mutable display name. Each record is persisted **atomically** — a reload
restores its queries, Dashboard, layout, and name together; every saved-query
edit commits the whole active workspace and only publishes once persistence
succeeds. Implicit startup reopens the last successfully used workspace.

The header **File ▾** menu carries the active name, an unsaved-changes dot
(changes since the last export or import), and these resource-oriented
operations:

The first four rows are one unlabeled primary-workspace-action group, in this
order (#342):

- **New workspace…** — creates and activates a new empty, default-named
  workspace without deleting the previous one. Open editor tabs are unaffected.
- **Import workspace…** — creates and activates a new local workspace from a
  portable bundle; imported identity is reminted and made unique. A
  multi-Dashboard file asks which Dashboard to adopt (or none).
- **Export workspace…** (`.json`) — write the one canonical
  **`altinity-sql-browser/portable-bundle`** interchange format: every saved
  query (catalog order) plus the zero-or-one Dashboard. Uses the deterministic
  canonical encoder and never mutates the workspace's identity or Dashboard
  revision.
- **Import queries…** — merge a file's queries into the current collection. When
  an incoming query's id collides with an existing one, a **conflict dialog**
  offers a default action plus per-row overrides — *use existing*, *copy* (import
  under a fresh id), *replace*, or *skip*; a byte-identical incoming query is
  reused automatically. The Dashboard is untouched (imported favorite flags never
  add tiles).

Below a separator, **Share / Publish** — **Download Markdown** (`.md`, a
`### heading` + fenced ` ```sql ` cookbook) and **Download SQL** (`.sql`,
`/* name + description */` comment blocks, `;`-delimited). Both are **one-way**
— lossy by design (no ids or Spec metadata), so the portable bundle stays the
canonical round-trip format. **Variable history** (the recent-values toggle +
clear-all) follows below its own separator.

The standalone Dashboard has its own **File ▾** menu (#302) for **Import
Dashboard…** / **Export Dashboard…** — importing replaces the current
Dashboard with one from a file (confirms first when a Dashboard already
exists, importing only its referenced queries; a multi-Dashboard file asks
which one), and exporting emits the selected Dashboard plus exactly its
dependency-closure of queries. Legacy Library v1/v2 files remain
**importable** everywhere (decoded to an in-memory bundle); no new
Library-only JSON is written. See the [schema
contracts](docs/library-json-schema.md). Imported SQL is never run
automatically.

The workspace name is editable inline (click it in the header). The **•** dot
appears after any change not yet written to a file and clears on export / import /
New workspace.

### Dashboard Filter sources

A favorited query whose Spec contains `"dashboard": { "role": "filter" }`
provides curated options instead of a tile. Its SQL must be one parameter-free,
row-returning statement with no trailing `FORMAT`, and must return exactly one
row. Each result column targets the Dashboard parameter with the same
case-sensitive name and may contain an ordered `Array(T)`, an ordered
`Array(Tuple(value T, label L))`, or a `Map(K,V)` (sorted by label then value).
The client preserves large integers and Decimals as strings, rejects NULL or
nested option values, limits each helper to 1,000 options, and falls back to the
ordinary parameter field when a source, consumer type, or provider conflicts.
Filter sources run and reconcile saved values before any Panel query starts.

The flagship bundles demonstrate the same contracts in context: readable
`Array(Tuple(value, label))` airport options in On-time, targeted country and
category filters in Shop, and inferred `Array(T)` multiselects for operational
query-log dimensions in ClickHouse Operations.

```sql
SELECT
  arraySort(groupUniqArray(toString(Origin))) AS origin,
  arraySort(groupUniqArray(toString(Dest))) AS destination
FROM ontime
```

## Quick start (development)

Source development requires **Node.js 22 or newer**. The committed `.nvmrc`
selects Node 22 for version managers such as `nvm`; `npm ci` exits with an
unsupported-engine error on older Node releases.

```bash
nvm use                # optional; reads Node 22 from .nvmrc
npm ci                 # exact dependency tree from the committed lockfile
npm test               # vitest + 100% coverage gate
npm run build          # → dist/sql.html (single file)
npm run dev            # build + serve dist/ at http://localhost:8900
```

### Run in Docker

The production image is a static **nginx** server for the single-file SPA — no
application backend. It serves `/sql` (and the `/sql/dashboard` client route),
serves a `config.json` you provide at `/sql/config.json`, and answers `/healthz`
for probes. Queries are **not** proxied: the browser POSTs them straight to the
chosen ClickHouse cluster, exactly like the on-cluster deployment.

Pull the published multi-arch image (`linux/amd64` + `linux/arm64`):

```bash
docker run --rm -p 8900:8080 \
  -v "$PWD/config.json:/config/config.json:ro" \
  ghcr.io/altinity/altinity-sql-browser:latest
```

Then open `http://localhost:8900/sql`. Tags: `latest` and `X.Y.Z` (releases),
`edge` (main), `sha-<commit>`.

The container listens on **8080** (non-root nginx). Provide your OAuth/host
config as a `config.json` (see [`deploy/config.json.example`](deploy/config.json.example)
and [docs/LOGIN-SCREEN.md](docs/LOGIN-SCREEN.md)) mounted at
`/config/config.json`. **With no mount** the image serves a built-in demo config
for the public Altinity clusters (antalya + github.demo), each offered as a
`demo:demo` credentials entry and a Google-SSO entry — so a bare
`docker run -p 8900:8080 ghcr.io/altinity/altinity-sql-browser:latest` is
immediately usable.

Set **`CONNECT_SRC`** to the space-separated origins the browser must reach —
your IdP endpoints plus every ClickHouse cluster origin in your `config.json`;
it fills the CSP `connect-src` (same-origin `'self'` is always included):

```bash
docker run --rm -p 8900:8080 \
  -v "$PWD/config.json:/config/config.json:ro" \
  -e CONNECT_SRC="https://accounts.google.com https://oauth2.googleapis.com https://clickhouse.example.com" \
  ghcr.io/altinity/altinity-sql-browser:latest
```

Or with Compose (builds locally, mounts the demo config, publishes on `$PORT`):

```bash
docker compose up --build          # → http://localhost:8900/sql
PORT=9000 docker compose up --build
```

Two caveats for the baked demo config:

- **OAuth from `localhost` won't complete** — the demo clusters' Google clients
  register redirect URIs on their own hosts, not `http://localhost:8900/sql`. Use
  the `demo:demo` credentials entries locally; the SSO entries work once the app
  is served from a registered origin.
- **Cross-origin queries need CORS** on the target cluster. ClickHouse's HTTP
  interface sends `Access-Control-Allow-Origin` for requests carrying an `Origin`
  by default, so the public demos work out of the box.

### Kubernetes (Helm)

A Helm chart is published to GHCR as an OCI artifact:

```bash
helm install sql-browser \
  oci://ghcr.io/altinity/altinity-sql-browser/helm/altinity-sql-browser \
  -n <namespace> -f values.yaml
```

Key values: `image.tag`, `connectSrc` (→ CSP `connect-src`), `config` (the
`config.json` served at `/sql/config.json`, rendered into a ConfigMap), and
`service.annotations`. The container serves plain HTTP on **8080** and runs
non-root (uid 101).

**Exposing a hostname.** For a standard cluster, enable `ingress` in values. In
an **Altinity edge-proxy** environment (e.g. `*.demo.altinity.cloud`) you instead
put edge-proxy annotations on the ClusterIP Service — TLS terminates at the edge
(wildcard cert) and wildcard DNS already resolves, so no ingress/cert/DNS is
needed:

```yaml
service:
  type: ClusterIP
  port: 8080
  annotations:
    edge-proxy.altinity.com/port-mapping: "443:tls-to-tcp:8080"
    edge-proxy.altinity.com/tls-server-name: sql.example.demo.altinity.cloud
```

The chart source is in [`helm/altinity-sql-browser/`](helm/altinity-sql-browser/);
a ready-made demo overlay is [`deploy/helm/values-demo.yaml`](deploy/helm/values-demo.yaml).
Plain (no-Helm) manifests are in [`deploy/k8s/`](deploy/k8s/).

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

**From a checkout** (also builds the SPA, requires Node.js 22 or newer):

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

**From Docker** — the container is a static nginx server that takes an explicit
`config.json` rather than reading `~/.clickhouse-client`. See
[Run in Docker](#run-in-docker) above.

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
  core/      pure logic — format, jwt, pkce, Spec schema service, share, sort,
             stream, storage, chart-data, completions (editor reference data
             + ranking) — no DOM, no globals
  net/       oauth-config, oauth, ch-client (injected fetch seam)
  editor/    injected CodeMirror islands: editable SQL + Spec adapters and the
             smaller read-only CodeViewer, sharing presentation/search base
  ui/        dom (hyperscript), icons, + render modules (login, tabs, schema,
             results, saved-history, shortcuts, splitters, toast, app)
  state.js   state model + pure operations
  main.js    bootstrap (OAuth callback, share-links, initial render)
  styles.css
schemas/      canonical Library, saved-query, and query.spec JSON Schemas;
              generated offline bundle + schema catalog
build/        schema compilation/bundling + esbuild → single-file dist/sql.html
deploy/       install.sh, uninstall.sh, http_handlers.xml, config.json.example
deploy/k8s/   sample Deployment, Service, ConfigMap, Ingress example
tests/        vitest + happy-dom, one spec per module
docs/         ARCHITECTURE.md, DEPLOYMENT.md, ASSET-DISTRIBUTION.md,
              CLICKHOUSE-OAUTH.md, CLICKHOUSE-OSS-OAUTH.md
```

## Supported browsers

Current **desktop** engines — Chromium (Chrome/Edge), Firefox, and **Safari
(WebKit)** — are all supported. The app uses one coordinate system — native
browser CSS pixels — for layout, pointer/caret/drag math, popover anchoring,
and the fullscreen graph panels; no application-level page-zoom compensation
(#148). Browser-native page zoom (⌘+/⌘-) remains supported by the browser and
requires no application handling.

CI exercises the editor (CM6 behaviors + insertion paths), schema-graph and
EXPLAIN-pipeline specs on all three engines (`webkit` added in #69), plus a
panel-sizing spec.

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
`src/` modules in **Chromium, Firefox and WebKit** for those cases — WebKit is
the Safari proxy (see [Supported browsers](#supported-browsers)).

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

`package-lock.json` is committed and every CI/release job uses `npm ci`, so a tag
build resolves the same complete dependency graph—including transitives—as a
local checkout of that commit. npm records platform-specific esbuild binaries as
optional packages and installs only the current platform's binary; the lockfile
therefore remains portable between Linux CI and macOS development.

## License

Apache-2.0.
