# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases (cut from `v*` tags by `.github/workflows/release.yml`) carry the
auto-generated per-PR notes; this file is the curated, human-readable history.

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Altinity/altinity-sql-browser/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Altinity/altinity-sql-browser/releases/tag/v0.1.0
