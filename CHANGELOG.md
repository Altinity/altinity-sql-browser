# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases (cut from `v*` tags by `.github/workflows/release.yml`) carry the
auto-generated per-PR notes; this file is the curated, human-readable history.

## [Unreleased]

### Added
- **The detached Data view is now interactive: Panel switcher + query filters**
  (#185). The Data pane's **Expand** used to open a frozen snapshot; it now
  opens a self-contained, re-runnable full-screen surface (real browser tab, or
  the in-app overlay fallback) bound to the result's captured `source`
  (`{sql, tabId, rowLimit, title, description}`, attached by `run()` on a normal
  row-returning result). The detached header shows that captured query title (a
  real heading; it also sets the browser-tab title) with the saved description
  clamped below it; a `{name:Type}` source gets a **filter row** built from the
  same shared control the SQL Browser and dashboards use (extracted to
  `src/ui/filter-bar.js`), and its Table | JSON | Panel switcher, sort, and
  column widths are local. Committing a filter or clicking **Refresh** re-runs
  **only** the detached query with full workbench parity — streaming, the
  server-side row cap, and real request abort — through one shared execution
  seam (`app.runReadInto`) that writes no tab/global state; a per-view
  generation guard + AbortController mean a stale or post-close response can
  never overwrite the current result. Filters read/write the same shared
  `varValues`/`filterActive`/`varRecent` stores (a value entered anywhere is
  offered everywhere; successful runs record recents via the shared recorder),
  the originating tab's ClickHouse session is reused when the source needed one,
  and the main workbench result/view/sort/panel/history and global running state
  are untouched. Copy always copies the current detached result. The
  Table/JSON/Panel dispatch is now one shared `renderResultView` used by both
  the live pane and the detached view (no parallel copies). No new runtime
  dependency. (Dashboard tiles moved onto the same shared streaming seam in
  #193 — see Changed below.)
- **Schema column name and type are now independent drag targets** (#186).
  Dragging a column's name still inserts the SQL-safe quoted identifier;
  dragging its type meta now inserts the complete schema-provided ClickHouse
  type — including every Enum member — never the compacted display text
  (e.g. dragging `Enum16(33 values)` inserts the full `Enum16('Close' = -11,
  …)` declaration). A new `COLUMN_TYPE_MIME` drag payload
  (`src/ui/dnd-mime.js`) keeps this separate from the existing identifier
  drag; the CodeMirror drop handler consumes it with identifier precedence
  preserved. Icon/whitespace and type-less columns carry no type-drag
  payload; database/table row dragging is unchanged.
- **Dashboard: one four-way layout switcher with a new Full-width mode**
  (#184). The dashboard's two separate layout controls (Arrange|Report plus a
  right-aligned Columns 2|3) collapse into a single segmented control —
  `Full width | Report | 2 columns | 3 columns` — so every effective layout is
  one click away. **Full width** is a new experimental mode: one tile per row
  filling the entire available dashboard width (inside the existing page
  gutters) for horizontally expansive Grafana-style panels, keeping the normal
  Arrange tile height rather than Report's taller document look. State is
  unchanged — `dashLayout` gains a `wide` value alongside `arrange`/`report`
  (no preference migration; existing selections stay valid) and `dashCols`
  keeps its 2/3 meaning. The control carries a `Dashboard layout` group label
  and per-button tooltips, exposes exactly one `aria-pressed` button, and
  layout changes stay presentation-only (no tile re-query).
  The saved-query visualization config is promoted from "a chart, plus special
  cases" to a first-class panel union — `panel.cfg.type ∈ bar | hbar | line |
  area | pie | table | logs | text` — designed in the results pane's new
  **Panel** tab (a Type picker + per-type config) and rendered identically as
  dashboard tiles by one registry (`src/ui/panels.js`), so drawer preview ≡
  tile by construction. Previews never execute SQL: they render from the tab's
  last explicit Run (the text panel needs no result at all — its Markdown
  lives in `panel.cfg.content`, rendered by an in-house safe subset parsed to
  an AST and built as DOM, raw HTML inert, http(s) links only, no new runtime
  dependency). The `logs` panel names its `{time, msg, level}` columns (with
  convention-based auto-detection covering `system.text_log` and OTel tables);
  `table` is the explicit plain-grid choice; text panels save with empty SQL,
  export their content to Markdown, and are skipped by the `.sql` script
  export. The **dashboard now partitions favorites before execution** — a
  text favorite renders immediately with zero queries — and nothing multi-row
  is skipped anymore: unconfigured results go log-shape → chartable → table
  (the log-shape signal outranks autoChart), explicit panels never vanish
  (zero-row explicit panels show an honest "0 rows" state), and grid tiles
  keep sort/column-width state across refreshes while the schema is unchanged.
  Tile fetches now carry best-effort server caps (`max_result_rows` sentinel +
  `max_result_bytes`, overflow `break`) with a guaranteed 5,000-row client
  trim and an honest "first 5,000 rows fetched" footer note (#164).
- **Library format: the `panel` field** (#166). `library.json` gains an
  optional `panel: {cfg, key?}` with `version` staying 1 (additive; older
  builds drop the unknown field). One pure `upgradeSavedEntry()` runs at
  every ingress — localStorage startup, JSON import, Replace/Append/merge,
  tab restore, share-link decode (including the OAuth round-trip stash) — so
  a user upgrading in place sees no visual change; `view:'table'` entries
  with a latent chart migrate losslessly (the chart roles ride in a nested
  stash and prefill a switch back to a chart type). **Rollback safety:**
  saves, exports and share links dual-write a legacy `chart` mirror for
  chart-family panels for one release (derived via one seam, so mirror and
  panel cannot drift; removing it next minor requires the upgrader to strip
  `chart` when `panel` exists). Unknown panel types and unknown cfg fields
  are preserved, never silently stripped.

### Changed
- **Data-skipping indexes moved off schema graph cards into the detail drawer**
  (#179). Expanded schema-graph cards no longer render the inline `idx: …` line:
  because a card's width is the widest rendered text line, long index names/types
  used to inflate the card and distort graph spacing (a heavily-indexed table
  spread far wider than the same columns with no indexes). Card geometry
  (width/height/layout/spacing) is now completely independent of index count,
  name, and type. The full index metadata instead appears in a new
  **Data-skipping indexes (N)** section of the bottom detail drawer, after
  Columns: every index (never a capped subset), with Name, Expression, full Type
  (`type_full` preferred so `bloom_filter(0.01)` / `tokenbf_v1(…)` stay
  distinguishable, falling back to `type`), Granularity, and compressed size —
  long Name/Expression/Type cells ellipsize with the full value on hover, and the
  section is omitted when a table has no skipping indexes. The rows are fetched
  once per detail-open (one read added to `loadTableDetail`'s existing parallel
  batch); the now-dead skip-index read `loadSchemaCards` issued on every graph
  load is gone. No new runtime dependency. (Follow-up to the #177 compact-type
  work.)
- **Dashboard tiles now stream through the shared `app.runReadInto` seam** (#193,
  follow-up to #185). Every query-backed tile runs on the same execution path as
  the workbench `run()` and the detached Data view instead of the bespoke
  `queryDashboardTile` (`FORMAT JSON`, whole-response `parseJsonResult`) it used
  before — gaining streaming transport, bounded client memory, live progress, and
  **real per-tile cancellation** via an `AbortController`. The read-only guard is
  preserved (`readonly:2` + `max_result_bytes` ride in the request; the row cap is
  the `newResult('Table', DASH_TILE_ROW_CAP)` client trim against a server
  `max_result_rows = CAP + 1` sentinel, so exactly-cap results are not flagged and
  `>CAP` are trimmed and flagged). Each wave reserves its slot generation **at
  creation** (aborting any in-flight request then) so a queued Refresh worker a
  newer filter wave has superseded discards itself without issuing — closing a
  stale-wave race; targeted filter re-runs now take one token preflight and the
  same 6-way concurrency pool as full Refresh. While a tile streams, only its
  loading placeholder's row count updates — panel classification and rendering
  happen once, on completion, so charts are never rebuilt mid-stream. Two small,
  deliberate behavior changes: a Dashboard panel query with an **explicit `FORMAT`
  clause** is now rejected with a clear tile error (the streaming parser only
  understands the structured stream, so a stray `FORMAT` would silently corrupt
  the tile), and the tile footer always shows ms (wall-clock) and bytes (streamed
  progress). The now-unused `app.runTile` / `queryDashboardTile` /
  `dashboardTileSql` / `parseJsonResult` machinery is deleted so future cap or
  settings fixes can't apply to only one path. No new runtime dependency; no change
  to the workbench or detached view.
- **One authoritative ClickHouse lexical scanner + structural lexer replaces the
  legacy highlighter tokenizer** (#182, supersedes #141). All string-based SQL
  analysis — statement splitting, parameter detection, optional-block/format
  handling, type display, completion, FROM/JOIN scope, and parameter-comparison
  inference — now runs on the shared `core/sql-spans.js` scanner (`{kind, start,
  end, closed}` spans, authoritative) and the new offset-bearing `core/sql-lex.js`
  structural lexer. The old `[type, text]` tokenizer in `core/sql-highlight.js`
  (and the private comment/quote skippers duplicated across `format.js`,
  `type-display.js`, and `optional-blocks.js`) are removed; its fallback keyword/
  function sets move to `core/sql-reference.js`. CodeMirror 6 keeps sole ownership
  of editor parsing/highlighting and gains the `hashComments` / `slashComments` /
  `doubleDollarQuotedStrings` dialect flags. Lexical fixes that follow from the
  unified scanner: `//` comments, restricted `#` (comment only before space/`!`),
  nested block comments, `$tag$` heredoc opacity (incl. heredoc Enum members),
  quoted-identifier escapes, and correct trailing-`FORMAT` / DDL schema-refresh
  classification after every supported comment form. No runtime dependency added.
- **A panel-config edit now dirties the tab like a SQL edit, and an untouched
  auto-derived config is no longer frozen into the entry on Save** (#166).
  Previously the Chart tab silently persisted whatever autoChart last derived;
  now `panel` persists only when restored or explicitly configured, and the
  preview renders a clone (render never mutates tab state). The detached Data
  Pane's third view is now a read-only render of the source tab's panel
  (previously an editable chart with its own config bar).
- **Grid renderer extracted into its own module with shared state wiring**
  (#167). The sortable/resizable data grid (`renderGrid`), the column-resize
  primitives (`colResizeWidth`, `resizeHandle`, `reapplyWidths`), and a new
  `renderGridView` adapter now live in `src/ui/grid-render.js`. The adapter
  centralizes the sort-update → repaint choreography that the main results
  table, the script-result rows viewer, and the detached Data pane each
  hand-rolled — the caller still owns where sort/width state lives and what a
  repaint means, so every surface keeps its exact state lifetime and repaint
  scope. Behavior-preserving; prepares the module boundary the Panels track
  (#166) builds on (a `table` panel becomes the fourth consumer without
  another copy of the wiring). A grid consumer may now omit `onCell` (cell
  clicks are inert instead of a TypeError).

### Fixed
- **Schema tree table actions open generated SQL in a new query tab instead of
  overwriting the active editor** (#180). Double-clicking a table used to
  `replaceEditor()` the current document with `SELECT * FROM … LIMIT 100`, and
  Shift-click replaced it with the formatted `SHOW CREATE` DDL — both could
  destroy an unrelated query the user was mid-edit on. Both actions now go
  through the existing `loadIntoNewTab()` path instead, naming the new tab with
  the unquoted `db.table` display name while the SQL itself still uses the
  SQL-safe `qualifyIdent()` result. Fetching/formatting the DDL is now shared
  between the editor-replacing `insertCreate()` (unchanged, still used by
  database rows) and the new tab-opening `openCreateInNewTab()` via a common
  `fetchCreateSql()` helper (`src/ui/app.js`, `src/ui/schema.js`). Database,
  column, drag, and expand/collapse behavior is unchanged.
- **The Logs rescue path deep-clones the saved panel configuration before
  handing it to controls** (#200). The rescue branch (#192/#195) fed Logs
  controls `{ ...saved.cfg }`, a shallow spread — any nested unknown field
  (the panel-config contract preserves fields it doesn't own, for forward
  compatibility) stayed aliased to the live `tab.panelCfg` until the explicit
  `onChange` write-back. `renderPanelView` now uses the canonical
  `clonePanelCfg` helper, matching the non-rescue path's already-deep-cloned
  `resolvePanel` output (`src/ui/panels.js`). No behavior change for the
  current string-valued Logs fields; this closes the gap for a future
  object-valued or extension field.
- **The detached Data view keeps its committed result visible during streaming
  reruns** (#198). Changing a filter or clicking **Refresh** used to repaint the
  in-flight result on every network chunk, which (a) flashed `Query returned 0
  rows.` whenever a chunk carried column metadata before any data rows, and (b)
  destroyed and recreated the Panel's Chart.js instance on every chunk. The
  detached view now follows the same commit-on-success policy as dashboard
  tiles: streaming updates a lightweight `Running… <n> rows read` status only,
  the previously committed Table/JSON/Panel (and its chart) stays on screen
  untouched, and the new result is committed and repainted exactly once after a
  successful current-generation completion. Failure, cancellation, supersession,
  and close all keep the previous committed result — and because the in-flight
  result is never painted, the old failure-time restore repaint is gone. Winning
  bound parameters are still recorded once; the committed toolbar row count no
  longer changes mid-stream (`src/ui/results.js`). Dashboard and workbench
  streaming behavior are unchanged.
- **The detached view's Logs (Panel) surface now scrolls** (#185 follow-up).
  A readonly panel renders straight into the block-level `.res-body` with no
  `.panel-body` flex wrapper, so the `flex:1; min-height:0` that bounds
  `.dash-logs` in the docked pane never applied — the logs list grew to its
  full content height and `.res-body`'s `overflow:hidden` clipped it with no
  way to scroll. `.res-body > .dash-logs` (and the `.panel-with-note` wrapper)
  now take `height:100%` like the adjacent `.chart-view`, so the list is
  bounded to the pane and its own `overflow:auto` scrolls (`src/styles.css`).
- **The workbench Panel tab keeps Logs authoring controls available when a
  saved Logs panel falls back** (#192). A saved `{type:'logs'}` panel whose
  Time/Message roles no longer resolve against the current result used to
  fall back to the ordinary fallback diagnostic and preview (usually Table)
  with no way to repair it — reselecting Logs from the picker is a same-type
  no-op, so the saved configuration was stuck. `renderPanelView` now derives
  controls from the saved Logs config whenever the fallback is a saved Logs
  panel (`src/ui/panels.js`), while the preview keeps rendering the existing
  `resolvePanel()` fallback + diagnostic unchanged; selecting explicit
  Time/Message/Level roles repairs the panel in place (marks the tab dirty,
  runs no SQL) and the next repaint renders Logs normally. Dashboard,
  detached, and other read-only surfaces are unaffected — the rescue is
  scoped to the editable workbench tab and strictly to a saved Logs type.
- **The Logs rescue's fallback preview is now read-only, so it can no longer
  silently overwrite the saved config** (#195). #192's rescue kept a saved
  Logs panel's Time/Message/Level controls available while it fell back to a
  Table *or* chart preview, but that fallback preview still rendered with its
  own normal, writable workbench controls — a fallback chart's X/Y/Series bar
  competed with the Logs controls above it, and editing the chart axes would
  replace the saved `{type:'logs'}` config with a derived chart config even
  though the chart was only ever a temporary stand-in. The rescue predicate
  (`hasGrid && saved?.cfg?.type === 'logs' && resolved.fallback`) is now
  computed once in `panelContext()` and shared by both the toolbar Panel
  picker (which now shows **Logs** as the active type throughout rescue,
  never the resolved fallback type) and `renderPanelView`, which renders the
  fallback preview with `readonly: true` (suppressing the chart arm's config
  bar entirely) and no `onCfgChange` callback. Repairing Time/Message/Level
  still writes the saved Logs config as before; choosing another type from
  the Panel picker remains the only way to explicitly convert away from Logs.
- **Logs role selectors now name a stale saved column instead of silently
  showing `(auto)`** (#196). When a saved Logs role (`time`/`msg`/`level`)
  pointed at a column name no longer present in the current result, its
  `<select>` had no matching `<option>`, so the browser fell back to
  displaying `(auto)` — visually indistinguishable from a role that was never
  explicitly configured, so editing a different role could silently persist
  the stale name unnoticed. `logsRoleSelect` (`src/ui/panels.js`) now derives
  a `logsRoleState` per role: a non-empty saved name that doesn't match any
  current column (case-insensitively, mirroring `resolveLogsShape`'s
  matching policy) renders as a selected, disabled `"<name> (missing)"`
  option with `aria-invalid`/`title` on the still-enabled `<select>`, so the
  user can pick a current column or `(auto)` to repair it, or leave it stored
  for later. Applies to all three roles (Level is optional, so a stale Level
  can be marked missing even while Logs renders normally). Rendering never
  mutates or canonicalizes `tab.panelCfg`. (Also fixed in passing: setting a
  detached `<option>`'s `.selected` before `appendChild` is not reliably
  honored under happy-dom — `panelSelect` now sets `sel.value` once after
  every option is attached.)
- **Unbounded column types no longer crush width-constrained UI** (#177). A
  declared type with an arbitrarily long body — a giant `Enum16(…)`, a
  many-field `Tuple(…)`, `Nested`/`Variant`/`AggregateFunction`/`JSON(…)` —
  used to consume the schema-tree row (reducing the column name to zero
  width) or was blindly character-cut in graph cards
  (`Enum16('Close' = -11, 'Err…`). A shared pure formatter
  (`core/type-display.js` `compactType`) now collapses unbounded declaration
  bodies to semantic summaries (`Enum16(41 values)`, `Tuple(12 fields)`,
  `Array(Tuple(12 fields))` — outer wrappers preserved; quote-aware,
  balanced-bracket, effectively linear scan; malformed input degrades to
  plain truncation) across the schema tree, the schema-detail table, column
  completion detail, and the schema graph cards. The full declared type
  stays reachable everywhere: row/cell hover titles, a per-column SVG
  `<title>` on graph cards, and the CM6 completion info pane (via a new
  `fullType` on column completion items). Long `CODEC(…)` chains in the
  detail table are capped the same way, and `.tree-row .meta` gained a CSS
  max-width backstop so no future raw value can reproduce the layout
  failure.

### Added
- **Optional SQL blocks `/*[ … ]*/` with explicit filter activation** (#165).
  A comment-wrapped predicate — `WHERE 1 /*[ AND d = {d:String} ]*/` — is
  included only while every parameter inside it is active; a blank filter now
  means "no filter" instead of blocking the run. The raw template is
  SQL-transparent (each block is a plain comment to any tool that doesn't know
  the convention, so it runs anywhere with all filters inactive), and values
  still bind only through native `{name:Type}` parameters — never
  interpolated. Wired through the #173 pipeline's two materializations: the
  all-active *analysis view* feeds the variables strip, the dashboard filter
  bar and affected-tile detection (block-only params get an "optional"
  affordance and never gate Run/tiles), and the *execution view* is what runs
  and exports — parameters of omitted blocks are never sent as `param_` args.
  Activation is explicit state (`state.filterActive`, persisted alongside
  `varValues`, blank ⇒ inactive for text controls, not carried in share
  links). Non-row-returning statements are never materialized; nested,
  unbalanced, parameterless, `;`-containing, whole-statement, or
  `*/`-containing blocks produce clear errors; and the Format action skips a
  statement containing blocks (with a notice) rather than round-tripping a
  template through server-side `formatQuery()`.
- **Typed client-side validation for `{name:Type}` variable inputs** (#170).
  A value is now checked against its declared type *before* the query is
  sent, for the numeric/scalar families that are cheap to validate purely:
  `Int8…Int256`/`UInt8…UInt256` (range-checked via `BigInt`; wraps like
  `256` for `UInt8` are blocked client-side even though ClickHouse's param
  path would silently accept and wrap them), `Float32`/`Float64` (decimal /
  scientific notation, `inf`/`nan`), `Bool` (a narrow, never-`invalid`
  accept-set — its live accept grammar isn't fully enumerable), and `UUID`
  (hyphenated or 32-hex compact). `String`/`Array`/`Map`/`Decimal`/`Enum`/
  `Date*` and any unrecognized type are always passed through unvalidated
  (`Enum` membership is #172; `Date`/`DateTime` relative expressions are
  #169). New pure `src/core/param-validate.js` (100% covered) plugs into
  #173's pipeline as its validation stage. A value is `invalid` only when
  ClickHouse's actual param-value grammar (verified live — not the SQL
  literal grammar) certainly rejects it; a plausible mid-typing prefix
  (`-`, `1e`, a half UUID) reads as neutral `incomplete` while the field is
  focused and hardens to the inline error on blur/Enter/execute. The
  workbench var-strip and the Dashboard's global filter bar (#149 D3) share
  one small affordance (`src/ui/var-field.js`) for the invalid-field styling
  + reason tooltip; an invalid value gates exactly like an unfilled one (Run
  disabled workbench-side, the tile placeholder dashboard-side). Also fixes
  two dormant gaps the validation stage exposed: the Run button's disabled
  state now reflects `invalid`/source errors, not just `missing` (previously
  only visually out of sync with the actual gate), and a field whose value
  fails serialization no longer rolls up as `ok` in `prepareParameterizedBatch`'s
  per-field state.
- **Relative time expressions for date/time variables** (#169). A
  `Date`/`Date32`/`DateTime`/`DateTime64(N)` (any `Nullable(…)`-wrapped)
  variable now accepts Grafana-grammar relative expressions — `-1h`,
  `now-7d`, `now/d` — alongside absolute values: the stored value is the
  expression, so it re-resolves against "now" on every workbench Run,
  Dashboard load/Refresh, or filter-change wave instead of freezing a
  timestamp the moment it's typed. New pure `src/core/relative-time.js`
  (100% covered) — `resolveRelativeValue`/`isDateLikeType`/
  `resolveVarValues` — parses the grammar (case-sensitive units; `s`/`m`/`h`
  offsets are fixed durations, `d`/`w`/`M`/`y` offsets and all `/u` rounding
  are local-timezone calendar arithmetic with DST-safe "same wall-clock time"
  semantics and month-end clamping) and formats per declared type (local
  calendar date / integer epoch seconds / epoch seconds with an `N`-digit
  fraction — live-verified against ClickHouse 26.3.13's `param_*` path). A
  near-miss expression (starts `now…` or sign+digits but fails to parse)
  gates via #170's existing invalid-field machinery, following its exact
  incomplete→invalid timing: neutral and non-blocking while still being
  typed (`now-`, `-1`, ordinary keystrokes toward a valid expression), and
  hardened to the visible inline error only on blur/Enter/execute — no
  second affordance, no separate timing model (review fix, post-merge).
  Plugs into #173's pipeline as the real `resolveRelativeValue` stage
  (previously identity). The UI is the first consumer of a new accessible
  type-to-filter combobox primitive (`src/ui/combobox.js`, #174 §1 — full
  keyboard map, ARIA `combobox`/`listbox`/`option` roles, IME-composition
  safety, mousedown-before-blur commit, `aria-describedby` wired to the
  preview/error element) composed in `src/ui/relative-time-field.js` with a
  live preview of the resolved instant as a human-readable UTC ("server
  time") calendar string (`2026-07-11 13:23:45`) — never the wire value
  actually sent (which stays epoch seconds/date per the declared type), and
  never converted to the viewer's local zone, so the same instant reads
  identically for every viewer; both the workbench var-strip and the
  Dashboard's global filter bar (#149 D3) upgrade their date-like fields to
  it, unchanged for every other type.
  Resolved instants are FLOORED to the whole second for every date/time type
  (never rounded), so `DateTime` and `DateTime64(0)` agree on the same
  instant and a resolved `now` never lands a second in the future.
- **Shared parameter pipeline (Phase 7.0)** (#173). A pure, two-phase,
  multi-source parameter pipeline — `analyzeParameterizedSources` (per-field
  declarations across all occurrences, per-source requiredness, cross-source
  type-conflict diagnostics) and `prepareParameterizedBatch` (per-source
  `{statements, missing, invalid, errors, runnable}` verdicts, immutable
  `boundParams` snapshots, per-param field states) — that
  #165/#169/#170/#171/#172/#160/#175 plug into (#165/#169/#170 via their own
  stage seams, real from their entries above; #171 below reads the
  `boundParams` output directly rather than overriding a stage; #172/#160/
  #175 still identity/unknown until they land). Includes a typed serializer: `Array(T)` values bind as ClickHouse
  array literals with correct quote/backslash escaping, big integers
  (`UInt64`/`UInt128`/`UInt256`, `Int128`/`Int256`) stay strings end-to-end
  (never through a JS `Number`), and scalar-string values remain
  byte-identical to before. Serialization is per-statement by the local
  declaration; a structurally incompatible stored value blocks only its own
  source — on the dashboard, one bad tile never blocks its siblings. Execution
  waves share one separately-injected wall clock (`env.wallNow`), distinct
  from the `performance.now`-based duration clock.
- **Per-variable recent-value history with an MRU dropdown** (#171). Every
  `{name:Type}` field now remembers its **10 most recently used** values,
  offered in a dropdown on focus (type-to-filter, click inserts, Esc/blur
  closes — the field stays free-text). A value is recorded only when a
  statement or dashboard tile **completes successfully**, read straight from
  that statement's #173 `boundParams` snapshot: a failed statement records
  nothing, statement 1 of a later-failing script still records, a param
  confined to an inactive #165 optional block is never recorded, and an
  empty string is never recorded even when actively bound. A relative-time
  value (#169) records the typed *expression* (`-1h`), never the resolved
  instant, so it keeps re-resolving on reuse. New pure
  `src/core/recent-values.js` (100% covered): `recordRecent`/`clearRecent`/
  `clearAllRecent` (MRU insert, exact-string dedupe/move-to-front, a 10-per-
  name cap and a ~100-entry global-LRU total cap across all names), plus
  `visibleRecents`/`filterRecentValues`/`recentOptions` — the render-time
  helper that hides (never deletes) a recent #170's validator marks invalid
  for the field's *current* declared type, so it reappears once viewed
  through a compatible declaration. Storage is `asb:varRecent`
  (versioned + sequence-stamped, name-keyed like `varValues`, shared/
  persisted the same way — plaintext, same exposure). Two new UI seams
  compose the existing accessible combobox primitive (`src/ui/combobox.js`,
  #174 §1) rather than building a second control: `src/ui/recent-field.js`
  (recents-only, for every non-date-like field) and an extension to
  `src/ui/relative-time-field.js` (adds an optional `getRecents` that
  upgrades its dropdown into ONE combined list — presets first, then a
  "Recent" group). A separate `src/ui/combo-footer.js` renders the per-field
  "Clear recent" affordance as its own small `position:fixed` box anchored
  under the listbox (kept out of `combobox.js` itself, whose `listEl` is
  fully owned by its own render pass, and out of the listbox's own
  `role="option"` items, where a destructive action would be an ARIA
  regression). The header **File** menu gains a "Variable history" section:
  a "Remember recent variable values" preference (recording off, existing
  history retained until cleared) and a "Clear all recent values" action —
  the closest thing the app has to a settings surface today. Both the
  workbench variables strip (app.js) and the Dashboard's global filter bar
  (#149 D3, dashboard.js) record on their respective success paths and share
  the same dropdown/footer wiring.
- **Enum variables render as a dropdown of their allowed values** (#172), two
  tiers, zero new network requests. **v1 (declared type, both surfaces):** a
  variable declared `{name:Enum8(…)}`/`Enum16(…)` (`Nullable(…)` unwrapped)
  gets a dropdown listing its member names, parsed straight out of the
  declaration by new pure `enumMembers`/`enumValues` (`src/core/param-type.js`,
  100% covered — reuses the shared string-span scanner so escaped quotes
  (`'a''b'`), braces (`'}'`), spacing variants, negative codes, and unicode
  member names all parse exactly like ClickHouse's own literal grammar, and
  implicit auto-numbered members — `Enum8('hello', 'world')`,
  `Enum8('One' = 1, 'Two', 'Three')` — get their real codes with ClickHouse's
  previous-code+1 rule).
  Membership is enforced (#170's invalid affordance, blocking) via a new
  `param-validate.js` branch: a LIVE-VERIFIED server fact (ClickHouse 26.3.13)
  is that a bare numeric code string (`1`) is ALSO accepted for a declared
  Enum param, binding as the member with that code — so validation accepts
  member names AND matching numeric codes (a strict digit prefix of a declared
  code, like `1` on the way to code `12`, stays neutral while typing, same as
  a member-name prefix), rejecting everything else with a
  reason that lists (and, past 8, samples + counts) the allowed values. Works
  in both the workbench variables strip and the Dashboard filter bar, since
  the declaration travels with the tile SQL. **v2 (schema-cache inference,
  workbench only, suggestions — never blocking):** a plain `{s:String}`
  compared directly to a column (`col = {s}` or `{s} = col`, qualified/aliased
  forms included — an expression, `IN`, `BETWEEN`, or the same param compared
  to two different columns all yield no match) whose *cached* type (#84's
  schema cache) is an Enum offers the identical dropdown, purely as
  suggestions: the declared type stays `String`, so a non-member still
  executes — the cache can lag the server. New pure
  `src/core/param-comparison.js` (`paramComparisonColumns`, 100% covered) finds
  the syntactic column reference; a new `resolveComparisonColumnType` in
  `src/core/from-scope.js` resolves it against the statement's FROM scope and
  the loaded schema (exactly one confident match required — ambiguous or
  not-yet-loaded degrades silently to a plain input, upgrading automatically
  once the column lands on the existing idle-tick loader; a background load
  that completes while the user is focused inside the variables strip DEFERS
  the strip rebuild until that field blurs, so it never steals focus, wipes
  in-progress text, or closes an open dropdown mid-typing). **Third consumer of
  the shared combobox** (`src/ui/combobox.js`, #174 §1) via new
  `src/ui/enum-field.js`: enum values render under a "Values" header once
  recents (#171) are also wired (paired labeling, exactly relative-time-
  field.js's own rule), a large `Enum16` (thousands of members) type-to-filters
  the COMPLETE member list first and only then caps the rendered rows at
  `ENUM_DROPDOWN_CAP` (≈200) with a "type to narrow" hint, so a member past the
  cap stays reachable by typing. `param-scan.js` gained a position-carrying
  `scanParamOccurrences` (the existing `scanParamDeclarations` is now a thin
  wrapper over it) so v2 can locate each param occurrence's FROM scope.

### Fixed
- **Phase 7 whole-branch review fixes** (#173/#165/#169/#170/#171/#172).
  Type-conflicted `{name}` declarations now *surface*: the field carries
  `conflict` through `fieldControls`, degrades to a plain text input on both
  the workbench var-strip and the dashboard filter bar (never a one-sided enum
  or date control), and shows an amber `.is-conflict` warning whose tooltip
  lists the disagreeing declarations. The #172 v2 schema-cache scan runs on the
  analysis materialization, so a `col = {p}` comparison inside a `/*[ … ]*/`
  optional block gets its dropdown too; and comparison-column conflicts are
  decided on *resolved* identity, not raw qualifier text (`e.status` +
  `status` in a single-table query now match; JOIN sides still don't).
  "Clear recent" now also empties the open dropdown list; a recent that
  duplicates a rendered enum member/preset is no longer listed twice; every
  execution path (run / script / both exports) captures its prepared args at
  wave start, so a value edited during a token-refresh await can no longer
  desync from the gate; the array-element serializer now shares the
  validator's live-verified Int/Float token grammar (rejects `007`, accepts
  `inf`/`nan`); and the var strip no longer analyzes the same SQL twice per
  editor keystroke. Manual-testing follow-ups (PR #176): a date-like field's
  combined dropdown now lists **Recent first, then Presets** (a recorded
  expression that duplicates a preset surfaces under Recent, not Presets —
  the enum/plain-recents fields are unchanged, still Values/plain-first);
  the "Clear recent" footer no longer lingers on screen after an option is
  picked via mousedown (`combobox.js` gained a shared `onClose` hook so every
  field module's footer hides on the same close path, not just focus/input/
  keydown/blur); and the README's Enum section now spells out that a bare
  `{o:Enum8}`/`{o:Enum16}` is rejected by ClickHouse (`Enum data type cannot
  be empty`) rather than inferring the dropdown.
- **Multi-statement SQL now binds query parameters per statement everywhere**
  (#155, absorbed by #173). `paramArgs` gated on the leading keyword of the
  whole text, so a favorite like `SET x = 1; SELECT {year:UInt16}` never
  received `param_year`; every gate/exec call site in the workbench and the
  dashboard now consumes the pipeline's per-statement batch instead.
- **Schema panel: a broken table in one data-lake-catalog database no longer
  hides every catalog database's tables** (#162). `loadSchema` queried
  `system.tables` across every database in one shot; once ClickHouse resolves
  per-table metadata for a `DataLakeCatalog` (Iceberg/Glue/…) database, a
  single unresolvable table there either aborts the whole query or (depending
  on `database_datalake_require_metadata_access`) silently drops tables from
  *other*, healthy catalogs too — traced to a ClickHouse-side gap, reported
  upstream as [ClickHouse/ClickHouse#110032](https://github.com/ClickHouse/ClickHouse/issues/110032).
  Each `DataLakeCatalog`-engine database is now queried separately, requesting
  only `database, name` — the one shape ClickHouse can resolve without opening
  each table's storage object, so one broken table can't take down anything
  else. Trade-off: `total_rows`/`total_bytes`/`comment` for catalog tables show
  as zero/empty rather than being fetched.

## [0.3.0] - 2026-07-04

### Added
- **Dashboard (phase 1): open your favorited Library queries as a read-only
  dashboard in a new tab** (#149). A new **File ▾ → "Open as dashboard"** item
  (enabled once at least one query is starred) opens `/sql/dashboard` — the same
  single served artifact, reached by a client-side route — and renders each
  favorited, chartable query as a live chart tile, reusing the existing Chart.js
  result view. The new tab is authenticated by a **one-time, same-origin
  `postMessage` credential handoff** from the opener (both the target origin and
  the peer window are verified); a cold/bookmarked visit falls back to the normal
  login flow, which returns to the dashboard after sign-in. Tile queries run
  **read-only** (`readonly=2`), so a favorite that happens to contain a write is
  rejected server-side rather than executed on open/refresh. Tiles fetch with a
  bounded concurrency (so a large favorites list doesn't stampede the cluster),
  the auth token is resolved once before they fan out (no intra-tab refresh
  race), and a handed-off-but-expired token is refreshed rather than forcing a
  re-login. Single-row (KPI) and non-chartable favorites are skipped for now with
  an "N not shown" note. KPI tiles, global filters, drag-to-arrange layout,
  per-tile controls, and export arrive in later phases (#149 D2–D7). Known
  limitation: two tabs independently refreshing a *rotating* OAuth refresh token
  can race (BroadcastChannel sync deferred).
- **Dashboard (phase 2): Arrange / Report layout switcher** (#149). A toolbar
  below the dashboard header (the future filter bar) adds a primary **Arrange |
  Report** segmented control: **Arrange** is the uniform multi-column grid, and
  **Report** lays the tiles out as a single full-width scrolling column with
  taller charts. A secondary **Columns 2 | 3** control tunes the Arrange grid
  (hidden in Report's single column). Both are presentation-only — switching
  reshapes the grid and the chart tiles resize themselves, with no tile re-query
  — and the choice is persisted per browser (`asb:dashLayout` / `asb:dashCols`),
  surviving reloads and Refresh. Chart tiles were also brought closer to the
  design: the saved query **description** shows as a subtitle under the tile
  name, the chart now draws on the **tile's own background** (instead of the
  darker results-table background), and the value-axis **gridlines are hidden**
  on tiles (they read as noisy light lines on a dark panel). Drag-to-reorder and
  1/2-column tile spans arrive in a later phase (#149 D4).
- **Dashboard (phase 3): global filter bar** (#149, #152). A **filter bar** in
  the dashboard toolbar renders one text field per `{name:Type}` parameter
  detected across every favorited tile's SQL (`dashboardParams`, unique by
  name, first-appearance order) — absent entirely when no favorite has one.
  Fields share the same persisted `state.varValues` the SQL Browser workbench
  already uses (#134): a value typed on the dashboard shows up in the
  workbench's variable strip for the same name, and vice versa. Typing
  debounces (~500 ms idle) before re-running only the tiles that reference the
  changed name — not the whole grid; Enter or blur commits immediately,
  bypassing the debounce. A tile whose SQL still has an empty/absent parameter
  never runs its query — it shows a distinct "Enter a value for: …" placeholder
  (excluded from the "N not shown" count, since one filter value away it
  becomes chartable). Tiles now live in **stable per-favorite slots** built up
  front and updated in place (loading/unfilled/error/chart) rather than
  inserted/removed, so a filter-driven tile flipping states repeatedly never
  reorders the grid or orphans its identity; each slot's fetch carries a
  monotonically increasing generation counter so a superseded in-flight
  response can never overwrite a newer edit's result. `ch-client.js`'s
  `queryJson`/`queryDashboardTile` gained an optional `params` argument
  (backward compatible) to forward `param_<name>` args to ClickHouse®. Per-tile
  Type/X/Y overrides, KPI tiles, and dropdown/cascading filters arrive in later
  phases (#149 D5–D7).
- **Schema-aware, FROM-driven autocompletion** (#84) — column completion now
  fires *while you type*, driven by the statement's `FROM`/`JOIN` clause, so you
  no longer have to expand a table in the sidebar first. A new pure module
  `src/core/from-scope.js` resolves the caret's statement into its base tables
  (`{db, table, alias}[]`, reusing the SQL tokenizer so strings/comments/`;`
  never fool it), and completion uses it three ways: **aliases resolve**
  (`e.` after `FROM events e` offers `events`' columns), **unqualified columns
  are scoped** to the statement's tables (an unrelated loaded table's columns
  are no longer suggested), and **columns load lazily** on a **debounced idle
  tick** (300 ms, never on the keystroke path) — deduped via the existing
  `'loading'` sentinel, cached per connection, and the open dropdown refreshes
  when they arrive. `db.table.`/`table.` qualification still works; with no
  FROM in view completion degrades gracefully to the global pool. Non-goals
  (v1): CTE/subquery-derived scopes, `USING`, `SELECT *` expansion, table
  functions. Builds directly on the CM6 editor (#21).

### Fixed
- **Editor scrollbars are back, and the whole UI's scrollbars behave
  consistently again.** The console no longer renders at 1.2× via `html{zoom}`
  (`--zoom` is now `1` — native size). `zoom:1.2` (= 6/5) landed element box
  sizes on fractional device pixels, and the leftover sub-pixel made scroll
  containers — the CodeMirror editor most visibly — read as "scrollable by
  ~1px" over content that visibly fit, painting a **phantom scrollbar** (the
  same rounding also drove the Safari viewport-unit divergence, #70). #145 had
  hidden the editor's bars outright to dodge it; with zoom removed the editor
  now uses the app's standard themed scrollbars like every other pane — a
  vertical bar for a long query, a horizontal bar for a long line, and nothing
  when the content fits. The UI is ~20% smaller than before; use browser zoom
  (⌘+) to enlarge. The now-dormant zoom-bridging machinery (`--vp-zoom`
  measurement, Chart/menu-anchor/splitter zoom correction) is left in place for
  a separate teardown (roadmap #68).

### Changed
- **The SQL editor is now CodeMirror 6** (#21) — the deliberate 4th bundled
  runtime dependency, replacing the hand-rolled textarea editor wholesale
  behind the #143 `EditorPort` seam (`src/editor/codemirror-adapter.js`;
  `main.js` swaps one injected factory). What changes for users: **per-tab
  undo history** (the shared textarea undo stack couldn't do this), real
  IME/touch editing, CM6's find/replace panel (`⌘F`), and measured-text
  rendering (no more fixed-glyph-width geometry). Highlighting still tracks
  the connected server's `system.keywords`/`functions` — the sets now feed a
  ClickHouse `SQLDialect` swapped via a Compartment on connect — and
  completion keeps the pure `core/completions.js` candidate set + ranking
  (CM6 renders the UI; `filter: false` preserves our order). Global shortcuts
  (`⌘↵` run, `⌘⇧↵` format, `⌘S`/`⌘⇧S`) stay on the document handler — CM6's
  conflicting `Mod-Enter` binding is stripped so an open completion can never
  swallow the run chord. Deleted with the cutover: the textarea adapter,
  `editor-complete/intel/search`, `core/editor-{marks,geometry,brackets,search}`
  and the `maskLiterals`-based literal masking (~2,600 LOC incl. tests) —
  execCommand undo, four-way scroll sync, and the editor's `html{zoom}`
  popover bridging all go with them. Signature help is dropped in this parity
  v0 (#60 rebuilds docs properly); function docs show as the completion info
  tooltip and on hover. Bundle: **+402,911 B raw (+83%) / +132,903 B gzip
  (+85%)** (484,674 → 887,585 raw; 155,810 → 288,713 gzip) — over the issue's
  raw estimate, accepted at the plan gate as the price of the Phase-4 editor
  foundation (#84 schema-aware autocomplete builds directly on this).
- **The SQL editor now sits behind an injected `EditorPort` seam** (#143): the
  hand-rolled textarea editor moved from `src/ui/` to `src/editor/` and is the
  first adapter (`createTextareaEditor`) of a small port interface
  (`src/editor/editor-port.js`) injected through `createApp(env)` like
  Chart/Dagre. The editor's state writes on typing (`tab.sql`/dirty, tab strip,
  Save button, #134 var strip) moved out of the adapter into an app-level
  `onDocChange` subscriber, and drag-and-drop MIME constants live in a neutral
  `src/ui/dnd-mime.js`. No user-visible change; this is the prep step that
  makes the CodeMirror 6 swap (#21) a reversible one-line adapter change.
  Bundle: +966 B raw / +428 B gzip (the port module — no new dependency).

### Added
- **Query variables** (#134): typed ClickHouse placeholders — `{name:Type}` —
  are detected while you edit, and a single-line strip below the editor toolbar
  shows one input per variable (it scrolls horizontally when there are many, and
  is hidden when there are none). **Run is disabled until every variable has a
  value.** On execution the values ride along as ClickHouse's native
  `param_<name>` query-string arguments, so the *server* substitutes them per the
  declared type (injection-safe; `String`/`Identifier`/`DateTime`/`Array`/`Map`
  all work) — the SQL text is sent unchanged. Substitution applies to
  row-returning statements only, so a `CREATE VIEW … {x:String} …` definition is
  stored verbatim (matching ClickHouse parameterized views). Run, ⌘↵, Explain,
  and Export all honor the same gate and pass the same params. Entered values are
  **shared by variable name across every query and persisted** (`asb:varValues`),
  so a value typed once is reused — prefilled automatically — wherever the same
  variable appears, and survives reloads. (Distinct from #39's `{{name}}`
  composable-query CTE-merge — different syntax and purpose.) The literal/comment
  lexing shared with the script splitter now lives in one scanner
  (`src/core/sql-spans.js`, #139), which also makes detection quote-aware inside a
  type — a `}` in `{e:Enum8('}' = 1)}` no longer truncates the placeholder.
- **Best-effort mobile mode** (#126): below a 768px viewport the shell becomes a
  **bottom-tab-nav workbench** — a bottom bar switches between three full-screen
  panels, **Tables / Editor / Results**, instead of squeezing the desktop
  sidebar + split panes onto a phone. Tables has a **Schema | Library** segmented
  toggle; Results carries a live badge (row count, or ● while a query streams).
  The nav follows the natural flow: tapping a schema column jumps to the Editor,
  loading a saved query opens it in the Editor, and running a query jumps to
  Results. Every pointer-only affordance is *removed* rather than left
  half-working on touch — all resize handles, the schema tree's native drag
  sources and hover tooltips, the drag-to-drawer schema-graph drop target, the
  graph-based `Pipeline` EXPLAIN view, and both graph fullscreen `Expand`
  buttons; button-anchored popovers (Save, user menu) center on-screen; the
  editor/results toolbars swipe-scroll; and the header declutters so the File /
  theme / user-menu controls fit. The core SQL loop stays fully usable: tap to
  browse the schema (a db-row tap still draws its lineage graph, via #124),
  write, run, read results, chart, and the four text/table EXPLAIN views. A
  single breakpoint (`MOBILE_BREAKPOINT_PX`, mirrored by the CSS `@media`) drives
  an injected `matchMedia` `isMobile` signal plus `mobileView` / `mobileTab`.
- **Click a closed database row to draw its schema graph** (#124): expanding a
  collapsed db in the tree now also draws its lineage in the bottom drawer, the
  same as dragging it — collapsing again doesn't re-fetch or re-draw.
  Drag-to-drawer is unchanged. On a schema with 50+ view/MV objects needing
  `EXPLAIN AST`, the inline graph now draws **progressively**: the free edges
  (dependencies/target/engine-arg/dictionary — no extra round trip) paint
  immediately, then a single second layout merges in the view/MV source edges
  once `EXPLAIN AST` settles, with a "resolving N/M…" toolbar readout. Below
  that threshold the fetch is fast enough that a visible first paint would just
  be flicker, so it still draws in one step. The loading placeholder / toolbar
  now has a working **Cancel**: it aborts the in-flight fetch and either keeps
  the already-drawn free-edges graph (marked partial) or falls back to the
  empty-results placeholder, whichever has something to show.

### Changed
- The build now minifies `src/styles.css` with esbuild's CSS transform (same
  minifier already used for the JS bundle) instead of inlining it raw — the
  stylesheet was shipping every source comment and all its indentation
  verbatim. Cuts the served artifact by ~23 KB (~4.7%), no new dependency
  (esbuild already provides the CSS minifier). Investigated gzip too: every
  demo cluster already serves the SPA gzip-compressed (ClickHouse's HTTP
  server compresses any static-handler response when the client sends
  `Accept-Encoding: gzip`, independent of any config in this repo) — verified
  ~54% smaller on the wire already, nothing to change there.

### Fixed
- **`npm test` flaked on Node 25** (#130): one `app.test.js` case asserted a
  persisted preference by reading the ambient `globalThis.localStorage` directly,
  which Node 25's native Web Storage (broken without `--localstorage-file`)
  leaves without a `getItem` method — a `TypeError` on a clean local run, though
  CI (Node 22) was unaffected. The test now stubs an in-memory store the way the
  `storage`/`state` specs already do, insulating the assertion from the host
  runtime; an `.nvmrc` pins local dev to Node 22 to match CI.
- The inline schema-lineage graph had a stale-write race (same class as #97):
  running or Explaining a query — or dragging/clicking a second db/table —
  while a lineage fetch was still in flight could let the stale fetch's
  resolution land on the tab's *new* result once it finally settled, silently
  showing an old graph instead of the actual query output. A request-identity
  guard now drops any write from a superseded fetch. Separately, an abort
  during the best-effort `system.dictionaries` read inside the lineage fetch is
  now correctly propagated as a cancellation instead of silently degrading to
  "no dictionaries, continue".
- Login screen: removed the footer's GitHub source link and "OAuth ·
  credentials" method tag — noise a first-time visitor had to parse before
  signing in (#123). The screen's other reported complexity (multiple visible
  panels, the server picker) is a deployment config choice, not a code issue.
  Consolidated all login-screen config docs (OAuth setup, multiple IdPs,
  credentials login, the host/Advanced picker, the local-dev saved-connection
  picker) out of the README into a single new
  [docs/LOGIN-SCREEN.md](docs/LOGIN-SCREEN.md), linked from the README.
- The sidebar's schema/library **splitter (drag to resize) stopped working**
  after #126: it resized `sidebar.firstElementChild`, which #126's new mobile
  segmented control (hidden on desktop) had silently become instead of the
  schema pane — so dragging visibly did nothing. Now targets the schema pane
  directly.
- **Iceberg/Glue/Unity/HMS/REST-catalog databases showed zero tables** (#122):
  ClickHouse >=25.8 hides `DataLakeCatalog`-backed databases from
  `system.tables`/`system.columns` unless
  `show_data_lake_catalogs_in_system_tables = 1` is set. The schema panel's
  table list, column expansion, table-detail pane, and schema-lineage graph
  now request that setting, falling back to the plain query (and remembering
  the fallback for the rest of the session, mirroring `ctx.authConfirmed`) on
  servers older than 25.8 that don't have it.

## [0.2.0] - 2026-07-01

### Added
- **Table/column COMMENT display**: a table's `COMMENT` now shows as a native
  hover tooltip on its node — in both the compact inline schema-lineage graph
  and the fullscreen rich-card graph, never a drawn line, so it can't affect
  either graph's layout — and in the table-info panel's header next to the kind
  badge. Column comments show as a new (wide) column in that panel's columns
  table. The panel's "uncompressed" byte column is replaced by "size %" — the
  percentage of the original (uncompressed) size still on disk after
  compression.
- **Multiquery + run-selection** (#83): run a `;`-separated script (DDL / INSERT /
  SELECT) in one shot, or run just the highlighted text. ⌘+Enter auto-detects — a
  single statement behaves exactly as before; more than one runs **sequentially**
  (one ClickHouse request per statement, stopping on the first failure) into a
  compact per-statement summary grid. A non-empty editor selection runs only that
  text (the Run button flips to **Run selection**); a single selected statement
  still gets the full Table/Chart/EXPLAIN view. Row-returning statements show the
  first row inline (comma-separated) — click to open all rows (capped at 100) in a
  side pane; effectful statements show **OK**. Each grid row also shows that
  statement's own execution time (the toolbar still shows the script total). The
  click-to-open row pane is the **same sortable + resizable grid** as the main
  results table (one shared component). A script that needs cross-statement state
  (a `CREATE TEMPORARY` table or a session `SET`) runs inside a **per-tab
  ClickHouse HTTP session** so that state persists across its separate
  per-statement requests; ordinary scripts run session-less. Cancel aborts mid-script. Splitting
  is purely lexical (`src/core/sql-split.js`), skipping `;` inside string/identifier
  literals and `--` / `#` / `/* */` comments. Known limitation: an `INSERT … FORMAT
  …` with inline data containing `;` mis-splits — run those on their own.
  **Format** pretty-prints each statement of a script and rejoins them (`;` + blank
  line; best-effort — an unformattable statement keeps its text), with a busy
  spinner on the button. **Explain** shows a clear message instead of a generic
  ClickHouse error when the editor holds more than one statement. Opening a saved
  query / history entry **auto-runs only read-only queries** — an effectful one
  (CREATE/ALTER/DROP/INSERT/…) loads into the editor without executing.
- **Result-row cap** with a 100 / 500 / 1000 / 5000 / 10000 selector in the result
  toolbar (default **500**, a global preference persisted across tabs and reloads).
  A normal `SELECT` now fetches at most the selected cap rather than pulling every
  row over the wire: ClickHouse stops cleanly at the cap server-side
  (`max_result_rows` + `result_overflow_mode = 'break'`), a small client-side guard
  trims the block-boundary overage `break` can leave, and a **"first N (capped)"**
  badge appears in the stats row when the limit is hit. Changing the selector
  re-runs the current query, so raising the cap genuinely fetches more. The display
  grid now renders up to the selected cap (10000 actually shows 10000). EXPLAIN /
  PIPELINE / ESTIMATE runs are exempt. (#86)
- Playwright e2e now runs on **WebKit** in addition to Chromium and Firefox, so
  many Safari regressions on the `html{zoom}`-based layout fail CI instead of
  shipping silently. README gained a **Supported browsers** stance: desktop
  Chromium/Firefox/Safari are supported; the full browser/ClickHouse/IdP matrix
  is tracked in #71. (#69)
- `tests/e2e/zoom-support.spec.js` regression-guards the fullscreen-panel sizing
  mechanism (#70) on all three engines. Caveat now documented: Playwright's WebKit
  is **not** a faithful Safari proxy for `zoom` × `getBoundingClientRect`/viewport
  units — it behaves like Chromium there — so that path is verified manually (#71).
- Small schema/EXPLAIN polish (#85): on ClickHouse ≥ 26.3, the EXPLAIN
  plain/Indexes/Projections views render with `pretty = 1, compact = 1` (older
  servers are unaffected — gated on the connected server's version); underscore-
  prefixed tables (`_…`) now sort to the end of each database in the schema
  sidebar and the lineage graph; opening a table's detail pane (fullscreen schema
  graph) shows a loading spinner immediately instead of a blank pane while its
  columns/partitions/DDL fetch; database rows show their `comment` as hover text
  when set (else the existing shortcut hints, now also noting drag-to-graph); and
  the no-comment table hover text now also notes drag-to-insert.
- **Streaming Export** (#87): a new **Export** button in the editor toolbar (next
  to Share) runs the current editor query **uncapped** and streams the result
  straight to a user-chosen file via the File System Access API
  (`showSaveFilePicker` → `resp.body` → disk), bypassing the result grid entirely
  — memory stays flat regardless of result size. Format follows the query: an
  explicit trailing `FORMAT <name>` (in either order relative to a `SETTINGS`
  clause) streams verbatim with a matching file extension; otherwise it defaults
  to `TabSeparatedWithNames`. An inline progress banner (bytes written · elapsed ·
  Cancel) tracks the export; Cancel aborts the stream and issues its own
  `KILL QUERY`, entirely separate from the grid run's cancel state. A **mid-stream**
  ClickHouse error (after the response has already started, so the HTTP status
  can't change) is detected via the `X-ClickHouse-Exception-Tag` header + the
  trailing `__exception__` frame and excised with a hold-back write buffer, so the
  error text is never written into the file — reported as "Export incomplete"
  instead. A session-less export of session-scoped SQL (a `CREATE TEMPORARY
  TABLE` / `SET` from earlier in the same tab) is guarded the same way the rest
  of the app handles those cases. Chromium + a secure context only (no File
  System Access API elsewhere) — the button stays visible but `aria-disabled`
  with an explanatory tooltip. **Replaces** the old result-panel Export
  (buffered CSV/TSV download of the already-loaded grid); Copy is unaffected.
- **Script export** (#99, a follow-up to #87): pressing **Export** on a
  multi-statement script (instead of a single query) opens a **directory**
  picker and runs the statements **sequentially** in one shared ClickHouse HTTP
  session — `SET` / `CREATE TEMPORARY TABLE` state carries across statements the
  same way a run does. Each row-returning statement streams **uncapped** to its
  own file (`NNN-slug.ext`, matching the log's `#` column); non-row statements
  run for effect and log OK/error with no file. A live log pane (metadata only
  — never the exported rows, so a multi-million-row script export stays flat)
  shows status/file/bytes/elapsed per statement; Cancel aborts the active
  statement, issues its own `KILL QUERY`, marks the rest **Skipped**, and keeps
  already-completed files. Stop-on-first-failure, no retry (unlike a normal
  script run, which retries a read-only statement once on a transient
  `SESSION_IS_LOCKED`) — a partially-written file shouldn't be silently
  re-attempted. A script with no result-producing statements shows a toast
  instead of prompting for a folder.
- **Detached-tab primitive + Data Pane Expand** (#100): extracted the schema
  graph's real-tab/overlay-fallback logic into a shared `openInDetachedTab`
  helper (`src/ui/detached-view.js`), now used by the schema graph, the
  EXPLAIN pipeline graph, and a new **Expand** button next to Copy in the
  results toolbar. Expand opens a **snapshot** of the current grid — sortable,
  resizable, with its own Copy, and the full **Table/JSON/Chart** switcher
  (same as the inline pane, but scoped locally: switching view/chart config
  there never touches the live tab's own state) — in a real browser tab,
  falling back to the in-app overlay when a pop-up can't be opened. It
  doesn't live-update if the query is re-run afterward. Pipeline's Expand now
  also opens in a real tab (previously overlay-only); the schema graph's
  existing tab/overlay behavior is unchanged. `app.state.detachedView` (a
  count) tracks how many detached views are open at once. Along the way,
  fixed Chart.js rendering nothing (a 0×0 canvas, then laid-out axes with no
  visible bars/points) when its canvas lives in a detached tab's own
  document — Chart.js's responsive-sizing and resize-triggered relayout read
  through APIs bound to the window its own module runs in, always the main
  window; `renderChart` now forces an explicit resize + `'resize'`-mode
  update off the canvas's own (realm-agnostic) geometry once it's attached.
  Also mirrors the app's favicon into every detached tab (a `faviconHref`
  seam, same pattern as the existing `stylesText` one) — `about:blank` ships
  neither, so a real tab previously showed the browser's generic icon.
- **Cell-detail drawer resize** (#101): the right-hand drawer used by both the
  cell-detail view and the rows viewer now has a drag handle on its left edge
  (`splitters.js` gains a fourth `'drawer'` axis alongside `col`/`sideRow`/`row`),
  clamped to `320px..92vw` and persisted as `cellDrawerPx` — one shared width for
  both. Fixed a click-through: finishing a resize drag with the mouse released
  over the backdrop (instead of the panel) previously closed the drawer, since
  the browser's post-mouseup `click` targets the nearest common ancestor of the
  mousedown/mouseup targets, bypassing the panel's own `stopPropagation`. Closing
  the drawer *mid-drag* (e.g. Escape while the mouse button is still down) now
  also cancels the in-progress drag and reverts the width, rather than leaving
  stray listeners that would persist a stale width or swallow a later, unrelated
  click.
- **UI consistency polish** (#102): the schema tree's expand/collapse chevron
  now rotates a single icon instead of swapping between two glyphs, matching
  the login screen's Advanced disclosure — the rotation actually animates
  (`flipChevron` restores the pre-toggle angle and forces a layout read before
  the target, since `renderSchema` rebuilds the row's DOM on every toggle and
  a freshly-created node has no "from" state for its CSS transition to
  interpolate from). The share toast can be dismissed early by clicking it (it
  no longer blocks clicks while visible); its auto-hide timer now lives on the
  toast element itself rather than a module-level field, so a toast in a
  detached tab's document can't clobber one in the main document's. Opening
  the user menu or the File menu now autofocuses a sensible first item (Log
  out / New Library). `shortcutsOpen`, `editingSavedId`, and
  `bannerDismissedFor` moved into `state.js` as signals, consistent with the
  rest of the ADR-0001 migration — no behavior change.

### Changed
- State reactivity now uses `@preact/signals-core` (the third bundled runtime
  dependency), adopted incrementally per
  [ADR-0001](docs/ADR-0001-reactivity.md): the tab list, side panel, run state
  (`running`/`resultView`), the library title, and now the **schema panel**
  (`schema`/`schemaError`/`schemaFilter`) repaint via signal `effect`s instead of
  manual render calls. No user-facing behavior change. A Preact schema-panel spike
  was evaluated and **rejected** — the app stays framework-free (ADR-0001
  addendum); the schema slice is the documented imperative exception, converted
  with a *replaced* Set-valued `expanded` signal and reference-replaced column
  loads rather than in-place mutation. This **completes the migration**. (#88, #91)
- **Chart-type-aware row cap** (#109): the flat 500-row chart cap is now a
  per-type lookup (`chartRowCap(type)` / `CHART_ROW_CAPS` in
  `src/core/chart-data.js`) — Pie 30, Bar (horizontal) 500, Column 1000, Line/
  Area 5000 — matching each chart shape's actual readability ceiling instead
  of one eyeballed number. Switching chart type re-slices to the new cap and
  updates the truncation note in lockstep.

### Fixed
- A newly created, still-empty database (e.g. `CREATE DATABASE`) never appeared
  in the schema tree, even after a reload/relogin: `loadSchema()` only listed
  databases that had at least one row in `system.tables`. It now enumerates
  databases from `system.databases` and attaches tables where they exist, so an
  empty database shows up immediately. Separately, the schema tree didn't
  refresh after running DDL at all — `CREATE`/`DROP`/`ALTER`/`RENAME`/
  `TRUNCATE`/`ATTACH`/`DETACH`/`EXCHANGE` now auto-reload the schema on a
  successful run, so the tree stays in sync without a manual page reload.
- Multiquery scripts no longer fail intermittently with **"Network error"**. A
  ClickHouse HTTP session is now attached **only when the SQL actually needs one**
  (a `CREATE TEMPORARY` table or a session `SET`), or when the tab already opened
  one (sticky, so that state persists across runs in the tab) — ordinary scripts
  run session-less, removing the session-lock / replica-affinity reset that
  surfaced (behind a proxy/LB) as a reset connection. When a session *is* in use,
  a transient failure is retried **only when safe**: a `SESSION_IS_LOCKED`
  (rejected before execution) or a connection reset on a **read-only** statement.
  A connection reset on an `INSERT`/DDL is **not** retried — it may have executed
  server-side, so it's surfaced as "the statement may have executed; re-run
  manually" rather than silently double-applied.
- The `session_id` / `query_id` fallback used when `crypto.randomUUID` is
  unavailable (non-secure `http://` contexts) now mixes in `Math.random` instead of
  only a coarse `performance.now()`, so two tabs can't mint the same id and collide
  on the session lock.
- Result-table **column resize** now uses a splitter model: dragging a column's
  right edge trades width with its right neighbor (the table's total width and the
  other columns stay put), instead of growing the whole table and shifting later
  columns sideways. Dragging the last column still widens the table. Applies to the
  data grid, the multiquery script grid, and the script-row pane (one shared grid).
- The fullscreen schema / EXPLAIN graph panels were mis-sized on **Safari** (#70).
  They size off viewport units, and engines disagree on how `vw`/`vh` interact
  with `html{zoom}`: Chromium's ignore `zoom` (so `100vh` overshoots one screen by
  the zoom factor and must be divided back), but WebKit/Safari's track `zoom`, so
  the existing `calc(.../var(--zoom))` correction shrank those panels to ~83%. The
  divisor is now measured at runtime (a `100vh` probe vs the one-screen `#root`)
  and published as `--vp-zoom` — ~`--zoom` on Chromium, ~1 on Safari — so the
  panels fit exactly one screen on both. The rest of the UI was already correct on
  Safari (its pointer/caret/drag corrections self-calibrate to the live rect
  ratio). A `@supports not (zoom: 1)` rule still neutralizes the factor to 1 on
  engines that can't parse `zoom` at all.
- The fullscreen schema graph's node detail pane could show stale data:
  clicking table A then quickly clicking table B before A's fetch resolved let
  A's slower response land last and silently replace B's already-mounted pane
  and selection ring — last-**resolved** wins instead of last-**clicked**.
  `openNodeDetail` now tracks the most recently requested node per overlay
  document and drops a fetch whose click has since been superseded. (#97)
- Cancelling or hitting a mid-stream error during a streaming Export (#87) left
  no recoverable file at all: on Chrome's File System Access API,
  `writable.abort()` leaves a hidden, 0-byte `.crswap` swap file behind and never
  materializes the visible target. `streamToFile` now `close()`s the writable
  instead, finalizing whatever bytes were already committed under the target
  handle, then renames it in place to `<name>.partial` via `FileSystemFileHandle
  .move()` (Chrome 110+) so a cancelled/failed export leaves a clearly-labeled,
  inspectable partial artifact. Falls back to leaving the plain (non-renamed)
  file on browsers without `.move()` support, or if the rename itself fails (#105).
- `createApp` built the `app` object with a `doc` field, but every other module
  (`explain-graph.js`, `results.js`, `schema-detail.js`, `file-menu.js`,
  `shortcuts.js`, `app.js` itself) read `app.document` instead — never
  assigned, so `app.document || document` silently always fell back to the
  global `document`, harmless today only because the two happened to coincide
  in both production and tests. `app` now exposes `document` (not `doc`), and
  the fallbacks that were provably unreachable (verified per call site against
  `makeApp()` / real callers) were dropped; the fallbacks that are
  deliberately null/minimal-`app`-tolerant (`detached-view.js`,
  `explain-graph.js`, `schema-detail.js`, and `shortcuts.js` — which has a
  dedicated `delete app.document` test) were left untouched. (#106)
- Every backdrop/panel modal (the cell-detail drawer, the rows-viewer pane, the
  graph overlay, the file-menu confirm dialog, the keyboard-shortcuts modal)
  closed on **any** `click` reaching its backdrop, without checking where the
  gesture's `mousedown` actually landed. A browser's `click` fires on the
  nearest common ancestor of `mousedown`/`mouseup`, not the `mousedown` target,
  so dragging a text selection from inside the panel past its edge before
  releasing produced a `click` targeting the backdrop directly — the panel's
  own `stopPropagation()` never ran (the panel wasn't in that click's
  propagation path at all) and the modal closed, discarding the in-progress
  selection. A new shared `attachBackdropClose` (`src/ui/dom.js`) tracks where
  `mousedown` landed and only closes on a `click` whose `mousedown` also
  landed on the backdrop itself; all five call sites now share it instead of
  each pairing an `onclick: close` backdrop with an `onclick: stopPropagation`
  panel. The cell-detail drawer's resize-drag one-shot click-swallow listener
  (#101) is superseded by the same general fix. (#110)
- The fullscreen schema graph's rich node card had no overflow cap on its
  `idx:` skip-index line — unlike columns (capped at `MAX_COLS` with a "+N
  more" row), every skip-index was joined onto one unbounded line. A
  heavily-indexed table (e.g. an OTel-style log table with a bloom filter per
  Map key/value plus a tokenbf on the body) produced a single line 1700px+
  wide, blowing the card — and the whole graph layout — out of proportion.
  `buildCardModel` now caps the line at `CARD.MAX_IDX` (6) with a "+N more"
  suffix, mirroring the columns' overflow pattern.

## [0.1.5] - 2026-06-29

### Added
- `SECURITY.md`: private vulnerability-disclosure policy + the `config.json`
  threat model (it's served to browsers — prefer a PKCE public client; lock the
  redirect URI if a `client_secret` is unavoidable) and the CSP/token baseline (#72).
- In-app build stamp: the build bakes `v<version> (<short-commit>)` into
  `dist/sql.html` (graceful `v<version>` fallback when not a git checkout) and
  shows it in the user menu, so a bug report can be tied to an exact build (#74).
- `NOTICE` + `THIRD-PARTY-NOTICES.md`, and the bundled Chart.js / dagre (MIT)
  notices are now embedded in the built `dist/sql.html`.
- `CONTRIBUTING.md` and this `CHANGELOG.md`.
- Dependabot configuration for npm + GitHub Actions updates.

## [0.1.4] - 2026-06-28

### Changed
- Schema detail pane: removed the "Insert SHOW CREATE" action button; opening a
  node now rings its card (a double border) and the ring clears on every
  pane-close path including Esc (#65).
- Code-review follow-ups for the schema/zoom work: extracted `schemaLayout()` and
  a `fixedAnchor()` helper, and the transitive-lineage node cap now counts only
  linked nodes so a large single database isn't truncated early (#64).

## [0.1.3] - 2026-06-28

### Changed
- Whole-database schema graph now draws **every** table (linked or not), packs the
  unlinked tables into a grid below the lineage, and drops the redundant `<db>.`
  prefix from node labels for objects in the focused database (#63).

## [0.1.2] - 2026-06-28

### Fixed
- Bridged the shipped `html { zoom }` across the full-view schema panel and the
  splitter / detail-pane-resize / popover coordinate math, so the full view fits
  one screen (the detail-pane DDL was previously pushed off-screen) and drags and
  popovers track the cursor (#62).

## [0.1.1] - 2026-06-28

### Added
- `antalya-oauth` demo connection (Google SSO).

### Changed
- Documentation updates; dropped the inaccurate "zero-dependency" framing (the
  app bundles two deliberate runtime dependencies).

## [0.1.0] - 2026-06-28

### Added
- Initial release: OAuth-gated (PKCE) single-file SQL browser served from
  ClickHouse — SQL editor, sortable results table + chart view, EXPLAIN pipeline
  graph, and the schema data-flow graph. Built by esbuild into one `dist/sql.html`.

[Unreleased]: https://github.com/Altinity/altinity-sql-browser/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Altinity/altinity-sql-browser/releases/tag/v0.1.0
