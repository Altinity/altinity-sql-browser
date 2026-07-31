# V2 UX & Interaction Handover

## Purpose

This document inventories altinity-sql-browser's **currently shipped** interaction behavior, plus the **committed-but-unshipped product contracts** already specified in open issues, for handoff into V2's professional UI redesign (tracked in [#582](https://github.com/Altinity/altinity-sql-browser/issues/582)). It exists so a redesign — whether done here or handed to a design tool such as Claude Design — starts from what actually exists and what's already been decided, rather than reverse-engineering behavior from screenshots or guessing at intent.

Claude Design's own mockup output is React-based regardless of what SQL Browser ships underneath, so the shell-implementation question (#577 Preact evaluation / #578 migration) is **not a prerequisite** for this handoff — it's tracked separately and determines implementation only, never the product/visual contracts below.

## How to use this document

Each section below distinguishes:
- **Shipped & stable** — what's actually implemented today, citing file paths and line numbers. Preserve this behavior unless the redesign explicitly intends to change it.
- **Committed target contracts (not yet fully live)** — product/interaction contracts already specified in open issues (chiefly #487, #488, #214, #420–423). Design *to* these contracts; they are not up for re-litigation as part of a visual redesign — only the visual language is open.
- **Accessibility** — what exists today and what gaps a redesign should close (several are called out explicitly in #73).
- **Behavioral invariants** — rules a redesign must not silently break, because breaking them would corrupt state, misdirect an action, or contradict an ADR-level decision.

This was compiled 2026-07-31 by source-reading agents (not exhaustive UI crawling) cross-checked against a live session of the app; screenshots taken during that live check (dashboard, query editor, schema graph, EXPLAIN pipeline graph, query history) are not embedded here since they carry live demo data, but were used to verify the surfaces described below actually render as documented.

---

## 1. Query editing & execution

The Workbench's query column is built by `mountWorkbenchShell` in `src/ui/workbench/workbench-shell.ts:110`. Top-to-bottom, the surface is five stacked bands inside `.workbench`:

```
.qtabs           query tab strip + [+] New query
.ed-toolbar      Run | Format | Explain | Save | [SQL|Spec] ····· Export | Share
.var-strip       one input per detected {name:Type} variable (hidden when none)
.editor-region   CodeMirror 6 SQL editor  OR  Spec JSON editor + status line
.row-resize      draggable horizontal splitter (persisted as editorPct)
.results-region  results toolbar + results body
```

### Controls and panels

**Tab strip** (`src/ui/tabs.ts:78`) — one `.qtab` per open query document, each with a name, an optional origin badge (workspace/dashboard provenance), an external-state marker (`!` changed elsewhere / `⌫` deleted elsewhere), a dirty dot, and a close `✕` (suppressed when only one tab remains). `+` opens a blank tab and focuses the editor.

**Editor toolbar** (`workbench-shell.ts:132`–`154`), left group then a flex spacer then a right group:

| Control | Element | Behavior |
|---|---|---|
| **Run** | `.run-btn` (primary) with `Icon.play` + `<kbd>⌘↵</kbd>` | `actions.run()`. Label swaps to **Run selection** when the editor has a non-empty selection, and to **Running…** (kbd hint dropped) while in flight — `setRunBtn` in `src/ui/app.ts:1032` |
| **Format** | `.tb-btn` | `actions.formatQuery()` — server-side `formatQuery()` round-trip, in place. Busy state shows a spinner + "Formatting…" (`setFmtBtn`, `app.ts:1264`) |
| **Explain** | `.tb-btn` | `actions.explainQuery()` — runs a derived EXPLAIN query; the editor text is never modified |
| **Format (Spec)** | `.tb-btn.spec-action` | Only visible in Spec mode |
| **Save** | `.tb-btn.save-btn` | Label is state-dependent: `Save` / `Saved` / **Resolve conflict** (`updateSaveBtn`, `app.ts:1705`) |
| **SQL \| Spec** | `.editor-mode-switch` (`role="group"`) | Two `aria-pressed` buttons. Spec is `aria-disabled` unless the tab is linked to a saved query; its tooltip states the specific reason |
| **Export** | `.tb-btn` | `actions.exportEntry()` — streams the full, uncapped result to a file via the File System Access API. `aria-disabled` (never natively `disabled`, so the explanatory tooltip still shows) when unsupported or already exporting — `setExportBtn`, `app.ts:1249` |
| **Share** | `.tb-btn` | Copies a share link; natively disabled when blocking Spec errors exist |

`app.updateEditorModeUi` (`workbench-shell.ts:191`) hides Run/Format/Explain/Export/Share and the variable strip wholesale in Spec mode, and shows the Spec Format button instead — the toolbar is mode-partitioned, not merely disabled.

**Results toolbar** (`buildToolbar`, `src/ui/results.ts:553`) is polymorphic — five distinct shapes depending on what the run produced:

1. *Ordinary result*: `[Table | JSON | Panel]` view tabs + panel type picker · **Rows** `<select>` row-limit cap · spacer · ms / rows / bytes stats · `Expand` · `Copy`.
2. *EXPLAIN*: five view tabs (Explain / Indexes / Projections / Pipeline / Estimate) with glyphs; stats suppressed; row-limit hidden; `Expand` for the Pipeline graph only.
3. *Raw output* (TSV/JSON `FORMAT`): a single always-active tab naming the format.
4. *Multiquery script*: `Script · N statements` title, elapsed, no view switcher/Copy/Export.
5. *Script export*: `Export script · N statements`, live elapsed, Cancel.

Row-limit options come from `RESULT_ROW_LIMIT_OPTIONS`; changing it **re-runs the query** with a new server-side cap (`setResultRowLimit`).

**Result grid** (`src/ui/grid-render.ts`) is one shared renderer used by the main table, the script-row side pane, and the detached Data pane. Sticky `<thead>`, a `#` row-number column, click-header-to-sort (asc → desc toggle, `Icon.sortAsc`/`sortDesc`), per-column drag resize via `.col-resize-h` (splitter model: the column grows and its right neighbour shrinks, so total width is stable; `MIN_COL = 48px`), numeric columns right-aligned via `isNumericType`, in-cell truncation with the full value on click in a right-side drawer (`openCellDetail`, `results.ts:1187`) which offers Rendered↔Source toggles for HTML (sandboxed iframe) and Markdown. Display is capped at `visCap(r)` with an in-body "… + N more rows truncated for display" footer.

**Export/copy paths**: `Copy` → `copyResult()` → clipboard; `Export` → `src/application/export-service.ts` (streaming single-file for one statement, per-statement directory export for a script).

### Keyboard shortcuts and editor interactions

There are two dispatch tiers, both declared in one catalogue — `SHORTCUT_CATALOG` in `src/ui/shortcuts.ts:32`, whose `dispatch` field is `'application'` (document-level handler) or `'editor'` (owned by the CodeMirror keymap). The same catalogue drives the `?` help dialog, so help can never document a command the dispatcher doesn't have.

| Keys | Action | Notes |
|---|---|---|
| `⌘↵` | Run query | Suppressed in Spec mode (`available`) |
| `⌘⇧↵` | Format active document | Routes to `formatSpec()` in Spec mode, `formatQuery()` otherwise |
| `⌘S` / `⌘⇧S` | Save / Share | Share unavailable in Spec mode |
| `⌘⌥1` / `⌘⌥2` | SQL / Spec editor mode | |
| `⌘Z` / `⌘⇧Z` | Undo / Redo | CM6 `historyKeymap`; **per-tab** history |
| `F1` | Open reference for symbol | CM6 keymap → `openReferenceCommand` |
| `Esc` | Closes the docs pane, else cancels a running query | `shortcuts.ts:53` |
| `⌘A` | Select-all inside a raw text / JSON / cell-detail `<pre>` | Only outside typing targets |
| `?` | Shortcut help dialog | Only outside typing targets |
| `g`-chords | Surface/layout navigation (`g d`, `g w`, …) | 1500 ms chord window, reset on blur |

CodeMirror keymap composition is in `createCodeMirrorEditor` (`src/editor/codemirror-adapter.ts:694`):

- **Autocomplete** — `autocompletion({ override: [completionSourceFor(app)] })` with CM6's default completion keymap (Ctrl-Space to force, arrows/PageUp/PageDown to move, Enter/Tab to accept, Esc to close). `Tab` is bound twice, in order: `acceptCompletion` first, then `insertTwoSpaces` (literal two spaces — no indent magic). Triggers on ≥1 typed character or on an explicit request; `filter: false` preserves the pure ranking from `core/completions.ts` rather than letting CM6 re-fuzzy-score. FROM-aware scoping (`fromScopeAt`) resolves `e.` → `events` and scopes bare columns to the statement's FROM/JOIN tables. Column metadata prefetch is debounced at `COLUMN_LOAD_DELAY_MS = 300` and **never runs on the keystroke path**.
- **Hover tooltips** — `hoverTooltip(hoverSourceFor(app))`: keyword docs and function signature cards, silent inside strings/comments/quoted identifiers. Cards paint local content synchronously, then upgrade in place from `app.catalog.docSummary` (with an `isLive()` guard), and always carry an `(reference — F1)` link.
- **Bracket/quote pairing** — `Prec.high` `inputGuards` (`codemirror-adapter.ts:238`) ahead of `closeBrackets()`: type-over a closer/quote, no pairing inside literals. `{` deliberately does **not** auto-pair, so it can't fight `{name:Type}` variables (`src/editor/ch-lang.ts:22`).
- **Search** — `search({ top: true })` + `searchKeymap` from `codemirror-base.ts`, with line numbers, `drawSelection`, and the `.sql-*` highlight class map.
- **Drag & drop** — `handleDrop` accepts three MIME payloads from the schema tree (identifier, `col::type`, subquery) and inserts at the *pointer* position with `dropCursor()` showing the target. Documented schema-tree gestures (in the help dialog's Gestures section): click = expand/collapse, double-click = insert into editor, shift-click = insert DDL / `col::type`.
- **Deliberate un-bindings**: CM6's `Mod-Enter` (`insertBlankLine`) and `Escape` (`simplifySelection`) are filtered out of `defaultKeymap` so `⌘↵` bubbles to the app's Run and `Esc` still cancels a running query. Completion and search keep their own Escape bindings.
- **Selection tracking** — a `selectionchange` listener gated on editor focus writes `state.hasSelection` (`workbench-shell.ts:303`), which is what flips Run → Run selection.

### States and how they render

| State | Rendering |
|---|---|
| **Empty / never run** | `.empty-results` centred chip with a play glyph: "Press `⌘↵` to run query" (`results.ts:265`) |
| **Starting** | `loadingPlaceholder('Starting query…')` while running with no rows and no raw text yet |
| **Streaming** | A 2px `.stream-strip` pinned to the top of the results body — determinate `scaleX(pct/100)` fill when total rows are known, else an indeterminate `.sweep`. Toolbar swaps static stats for three `.stat.live` readouts (elapsed ms ticked in place, rows, bytes) plus a **Cancel** button carrying `<kbd>Esc</kbd>`. Mobile Results nav badge shows `●` |
| **Success** | Toolbar shows ms / rows / bytes; `Expand` + `Copy` appear. A `.capped-badge` reading `first N (capped)` when the fetch stopped at the row limit |
| **Empty result set** | `.placeholder` — "Query returned 0 rows." (`renderResultView`, `results.ts:863`). The Panel view still renders (a text panel needs no rows) |
| **Error** | `.results-error` block with the raw server message, persistent in the results body. View tabs stay visible on error so a failing EXPLAIN view can be switched away from |
| **Format error** | A synthetic `{...newResult('Table'), error, formatError: true}` result forces the Table view, plus `sqlEditor.revealOffset(pos)` to jump the caret to the reported token. A later successful format clears only this (`clearFormatError`, `app.ts:1279`) |
| **Cancelled** | `.cancelled-badge` — "Cancelled · partial" |
| **Blocked by unfilled variables** | Run is natively disabled with a tooltip "Enter a value for: …"; the same gate is re-enforced in `run()`/`runScript()` so Explain, row-limit re-runs, and Export are gated too |
| **Refused operations** | Transient toasts (`flashToast`, 1.6 s, or 30 s for `✕`-prefixed errors): "Explain isn't available for a multi-statement script…", "Statement contains optional blocks — not formatted", "Fix Spec errors before sharing" |
| **Export in progress** | A body-level `.export-progress` banner with spinner, "Exporting…", live `bytes · Ns`, and Cancel (`app.ts:1671`) |
| **Script run** | A per-statement grid — Statement / Result / Time; a SELECT row shows a first-row preview and `(N rows)`, clickable to open all rows in a stacked drawer; the failing statement's error renders in its own cell (execution stops at first failure) |
| **Spec mode diagnostics** | `.spec-status` line under the Spec editor: `Line L, column C: message — N errors`, plus inline CM6 decorations (`spec-diagnostic-{severity}`) |

### Accessibility — what exists, and the gaps

Present:
- Tab strip is a real tablist: `role="tablist"` + `aria-label="Open query tabs"` on the host, `role="tab"` / `aria-selected` / roving `tabindex` on each button, Arrow/Home/End navigation with focus preserved across the render replacement (`tabs.ts:90`, `tabs.ts:138`). Decorative markers are `aria-hidden`; close buttons have explicit `aria-label`s; `tabAccessibleLabel` folds the origin context and dirty/conflict state into the accessible name.
- Editor-mode switch is `role="group"` + `aria-label="Editor mode"` with `aria-pressed` and `aria-disabled` reflected.
- `.spec-status` is `role="status" aria-live="polite"`.
- The detached Data pane's own status line is `role="status"` (`results.ts:1142`).
- Disabled-but-explanatory buttons deliberately use `aria-disabled` + `title` rather than native `disabled`, because a natively disabled button swallows pointer events and its tooltip never shows.
- Shortcut help is a proper modal: `role="dialog"` + `aria-modal` + `aria-labelledby`, Tab focus trap, Escape to close, focus restored to the previously focused element on close, and a `KeyboardOwner` lease so global shortcuts stand down while it's open. The same `acquireKeyboardOwner('modal')` lease is taken by the cell-detail and rows-viewer drawers.
- Stacked drawers resolve Escape by depth (`isTopDrawer`) so dismissing a cell drawer returns to the rows pane rather than closing both.
- CM6 supplies its own combobox semantics for the completion popup.
- Every semantic colour is paired with text or an icon per DESIGN.md, and `tests/unit/typography-contract.test.js` mechanically asserts WCAG AA contrast on every token pair in both themes plus that no rendered class lacks a CSS rule.

Gaps a V2 should treat as open work:
- **No live region for query lifecycle.** Run start, completion, row count, error, and cancellation are visual only — a screen-reader user gets no announcement that the query finished or failed. `.results-error` is a plain `<div>`, not `role="alert"`.
- **The result grid is a plain `<table>`.** No `scope="col"` on headers, no `aria-sort` on the sorted column (sort direction is conveyed by icon only), no `role="grid"`/cell navigation. Sorting and resizing are **mouse-only**: headers are `<th onclick>` (not focusable buttons, no Enter/Space), and `startColumnResize` is `mousedown`-driven with no keyboard equivalent.
- **Cells open the detail drawer on click but aren't focusable or keyboard-activatable** (`grid-render.ts:223`); same for the script grid's clickable outcome cell.
- **Result view tabs and EXPLAIN view tabs are bare `<button>`s in a `<div>`** with an `active` class only — no `role="tablist"`/`role="tab"`/`aria-selected`, unlike the query tab strip that does it correctly. Same for the detached pane's switcher.
- **The row-limit `<select>`** has a visible "Rows" span but no programmatic label association (no `for`/`id`; it relies on being wrapped in the `<label>`, which does work, but the pattern is inconsistent with the labelled fields elsewhere).
- **Raw text / JSON views** are `tabindex="0"` scroll containers with no accessible name or role.
- Drag-and-drop insertion, the editor/results splitter, and column resize have no keyboard alternatives (the left-nav separator, by contrast, *does* — `mountLeftNavSeparator` + a `role="status"` announcement region — so there is an in-repo pattern to copy).

### Behavioral invariants a V2 must not break

1. **SQL operations always address `app.sqlEditor` explicitly — never "the visible document."** ADR-0001's #212 addendum states it directly: "Execution, schema insertion, SQL formatting, and Export always address the SQL adapter; changing which document is visible cannot redirect a SQL operation to JSON." The former `app.editor` ambiguity was removed deliberately.
2. **Each tab owns independent documents and independent editor state.** `sqlDraft` and `specText` are separate; each adapter parks its own `EditorState` per tab, so undo history, selection, scroll, and search are per-tab and per-mode.
3. **Programmatic syncs must not look like user edits.** `onDocChange` subscribers are suppressed only when *every* transaction in an update is a sync — a coalesced user edit still propagates. A tab switch must never dirty the incoming tab.
4. **A parked selection is collapsed on restore**, because `⌘↵` and Export read `getSelection()` without a focus check — an invisible restored selection would silently retarget execution.
5. **Explain and view switching never rewrite the editor.** EXPLAIN runs a derived query; clicking an EXPLAIN view tab re-runs it.
6. **Statements containing `/*[ ]*/` optional blocks are never round-tripped through server-side `formatQuery()`** — it would mangle the markers and destroy the template.
7. **Format is idempotent and keeps undo live.**
8. **Explain is refused where it is invoked, not silently swallowed** (ADR-0003).
9. **One unfilled-variable gate at the execution choke points.** `run()`/`runScript()` enforce it, so Run, Explain, row-limit re-runs, and Export are all gated identically.
10. **Cancellation is real, on both ends** — aborts the stream *and* issues `KILL QUERY`. A cancelled or superseded response must never paint.
11. **Script export holds metadata only, never exported rows.**
12. **The detached Data pane shares variable state but nothing else** — captures source SQL and session at expand time, never re-reads the active tab; commit-on-success only.
13. **One shared grid renderer, one shared view dispatch** across the live pane, script-row drawer, and detached pane — introduced precisely so surfaces can't drift into parallel copies.
14. **Chart.js instances are destroyed before any DOM rebuild**, or canvas observers leak.
15. **The editor layer never imports UI** — mechanically enforced by `build/check-boundaries.mjs`.
16. **Mobile (≤768px) is a mode, not a scaled layout.** Pan/zoom-only affordances are hidden, not left as dead controls; drag-drop is dropped entirely (touch doesn't fire native drag).
17. **No `innerHTML` and no `marked.parse()`** anywhere in this surface.

Relevant files: `src/ui/workbench/workbench-shell.ts`, `workbench-session.ts`, `src/ui/results.ts`, `grid-render.ts`, `shortcuts.ts`, `tabs.ts`, `src/editor/codemirror-adapter.ts`, `codemirror-base.ts`, `ch-lang.ts`, `editor-port.ts`, `spec-editor.ts`, `src/ui/app.ts`, `src/application/export-service.ts`, `DESIGN.md` §"SQL Editor"/"Data Table", `docs/ADR-0001-reactivity.md` #212/#213 addenda.

---

## 2. Dashboard

### 2a. Data model, layouts, and presentation resolution

**Two distinct nouns.** A **panel** is a *presentation config on a saved query* (`spec.panel = {cfg, key?, fieldConfig?}`); a **tile** is a *Dashboard-local instance* that references a query by id. Placement is neither — it lives in a third place, the layout document keyed by tile id.

- Tile shape: `DashboardTileV1` (`src/generated/json-schema.types.ts:826`; `schemas/dashboard-v1.schema.json:79`). Persisted: `id`, `queryId`, optional `title`/`description`/`presentation`. Closed object. "Actual placement and size live in the layout document."
- Dashboard document: `DashboardDocumentV2` — `documentVersion:2`, `id`, `title`, `description?`, `revision` (incremented once per successfully committed mutation; validation/preview/export never bump it), `layout`, `tiles[]` (≤100), `variableConfigs?`.
- **`tiles[]` order is the single canonical order** for execution planning, DOM/keyboard traversal, fallback rendering, print/export, and serialization.

**Panel/view kinds** — closed union: `kpi | bar | hbar | line | area | pie | table | logs | text`, plus `FuturePanelCfg` (unknown types are storable/preserved; rendering degrades). Per-arm persisted fields cover chart axes/series/style, KPI read-out, logs column-name mapping, and `text` (the only queryless arm). Unknown cfg fields are ignored by validation and preserved by clone/normalize — a hard forward-compat rule.

**"Tile membership"** = whether a query has a tile referencing it, fully decoupled from favourites since #427 — a star can no longer create/remove a tile.

**Runtime caps**: `DASH_TILE_ROW_CAP = 5000`, `DASH_TILE_BYTE_CAP = 50MB` (not a security boundary), `DASH_TABLE_DISPLAY_CAP = 1000` with a "+N more rows truncated for display" footer.

**Layouts — three registered plugins, two engines**: `flow@1`, `grafana-grid@1`, `grafana-grid@2`. Plugin contract is only `normalize(doc)` + `validatePlacement(placement, path)`.

- **flow@1** (the universal fallback): presets → desktop columns `report:1, columns-2:2, columns-3:3`; placement `{span ∈ {1,2,3}, height ∈ {compact,medium,large}}`; mobile breakpoint 768px forces 1 column **without touching the persisted preset/span/height**; a maximal run of KPI tiles bands into one full-width row.
- **grafana-grid**: 12-column max, rowless; height is numeric row units 1–16 (`px = 32 + 88*units`); responsive column clamp by width; v2 authored styles (`grid`/`full`/`report` presets) keep three *independent* per-tile dimension maps that never inherit each other's numbers; `columns-2`/`columns-3` previews are session-only and never persisted.
- **Registry rule**: flow@1 is always inserted first and can never be shadowed — it's the universal fallback. Every grid mutation regenerates a fully explicit flow@1 fallback for every tile.
- **Persisted vs computed**: persisted = preset/items; computed-and-never-written-back = column count, effective/clamped span, row/col position, mobile normalization, preview spans/heights.

**Presentation resolution** (`presentation-resolver.ts`) is *the* single resolver shared by Workbench preview, viewer, import validation, tests, and MCP/AI callers. Exact order: base panel cfg → variant patch (fails closed if the named variant doesn't exist) → tile override merge-patch → renderer-type lock (neither variant nor override may change or delete the resolved type) → structural validation → result-column role validation (only when columns are supplied). A schema change retains the explicit type and re-derives roles inside it; only an impossible type falls back to auto-detection with a diagnostic.

**Variables — not persisted objects, inferred.** A Dashboard's variables are derived from `{name:Type}` placeholders in the queries its panel tiles own, aggregated by exact case-sensitive name. Three statuses: `active` (agreeing types), `conflicted` (disagreeing types), `orphaned` (stored option SQL, no declaring query). Only persisted variable state is `variableConfigs[name] = {sql, lastKnownType?}` — option SQL must return exactly two String columns (value, then label) by position. Runtime values persist separately under one localStorage key (`asb:dashFilters`). A variable with no value makes its panels **wait** (`unfilled`), never run unfiltered; an empty selection is `UNSET`, never `[]`.

**Export/share**: two builders — one Dashboard + its exact dependency closure, or the whole workspace. Both deep-clone so an export can never mutate live state (including `revision`) through the returned bundle. Portable-bundle codec limits: 20 MiB decoded JSON, 100 tiles/layout-items per Dashboard, 32 Dashboards, 1 MiB per SQL string, etc.

### 2b. Application layer — commands, execution, edit/view mode

**Command layer** (`src/dashboard/application/dashboard-commands.ts`) — a pure `applyCommand` APPLY step: `add-query` / `add-query-instance` (canonical add path) / `duplicate-tile` / `remove-tile` / `move-tile` (out-of-range fails, never clamps) / `update-tile` (title/description/presentation patch; `id`/`queryId` never patchable) / `update-placement` (validated by the active engine plugin) / `change-layout` (Style menu). Every tiles/placement-mutating command regenerates the flow@1 fallback centrally.

**Two-resource writes** (`queries[]` + `dashboards[]` together, since a panel tile owns a dedicated query copy): `createPanelCandidate` (Add panel), `duplicateDashboardPanel` (keeps the source's name, no "copy" suffix), `copyLibraryQueryToPanel` (Library drag / "Add to dashboard…"), `removeDashboardPanel` (tile **plus** its dedicated query copy, ownership *proven* via single-owner + role check before cascading), `removeDashboardDocument` (whole-Dashboard delete, cascades only solely-owned panel queries). `panelRemovalRefusal` is a **dry run** of the removal transform so a menu row can be listed-but-unavailable instead of opening a confirmation that then refuses.

**Per-tile `⋯` menu**: `duplicate | widen | open | remove`, paint order duplicate → widen → open ("Open in Workbench and run") → remove (last, separated, destructive). Rows are always **listed** even when unavailable, with a sentence explaining why. Only remove carries a confirmation, and only when actually available; duplicate has no confirmation and no precondition this surface can check.

**Widen**: a *cycle*, not monotonic growth — grid doubles span and wraps 12→1; flow presets +1 and wrap. `report`/`full` are single-column and expose no widen at all.

**Undo**: there is no undo stack. The only "undo" is an optimistic-command FIFO queue re-applied against committed truth at dequeue, with a "Change no longer applies — undone" toast when a rebase fails.

**Edit vs view mode** (ADR-0003): route contract `/sql?ws=…&surface=dashboard[&mode=view]` — edit is the default. View mode over a workspace with no dashboard shows "This workspace has no dashboard" and **executes no queries**; edit shows "Create dashboard" but visiting never creates one. View is *presentation, not authorization* — the same live workspace document, same single variable bar in both modes; a local user can always switch back to edit. One `const readOnly = target.mode === 'view'` render gate, resolved once per load: edit-only chrome (drag grip, resize handle, `⋯` menu, inline widen) is not *built*, not merely hidden; unconditional in both modes: tile heading and **Open in Workbench** (an explicit ADR call that this is not edit-mode chrome).

**Panel execution lifecycle** (`dashboard-viewer-session.ts`) owns runtime-only state, nothing persisted, and may not import `src/ui`/`src/application`/`src/net`/`AppState`/the editor adapters. Per-tile status: `idle | loading | unfilled | error | ready`. Concurrency: bounded pool of 6 (`VIEWER_TILE_CONCURRENCY`); option-SQL batch runs concurrently with the tile pool. Stale-wave handling: every wave reserves all generations synchronously before its first await, so a superseded wave can never be the last to publish — there's no request queue beyond the pool, a new wave supersedes rather than enqueues. Auth preflight on every wave; a suspended scope means the document stays viewable but no server work starts. Cancellation aborts and reverts `loading → idle`; auth loss aborts everything but **restores each tile's last committed result** rather than blanking it. No auto-refresh timer anywhere — refresh is user-driven.

**Loading/empty/error states**: empty dashboard → File-menu "New dashboard" / empty-workspace placeholder, `{tiles: []}`. Per-tile `loading` streams progress rows; `unfilled` (a variable needs a value) is a distinct third state, not an error. Three separate diagnostic channels never overwrite each other: structural/presentation diagnostics (computed up front, visible without executing), option-batch diagnostics (replaced wholesale per wave), time-range diagnostics (path-mapped to the offending tile). A configured-but-locally-rejected variable stays a select and reports its error — it never silently degrades to a text box.

**Autoscroll & tree UI state**: tile-drag edge auto-scroll ramps speed inside an 80px edge zone, clamped under `prefers-reduced-motion`. The Dashboards tree's session UI state (expansion, search, scroll, roving-tabindex row) is keyed by immutable workspace id, never persisted, and deliberately **not a signal** — an observing effect would repaint the tree on every keystroke and lose the caret; search never writes the user's expansion sets.

### Invariants a redesign must preserve

1. A panel tile is the **sole owner** of a dedicated saved-query copy; ownership is derived from references, never stored.
2. Every panel add/duplicate/assign is therefore a two-resource write, and delete must cascade to the owned copy — proven, never guessed (ambiguous ids refuse rather than resolve by guessing).
3. Exactly one revision bump per command, on the target Dashboard only.
4. The viewer session owns runtime-only state and cannot import UI/application/net/editor layers.
5. Session-fixed vs syncable: variables, controls, option batch, and parameter analyses are computed **once at construction**; a tile-membership change must rebuild the session, not sync.
6. `columns-2`/`columns-3` previews are session-local only and must never be written; discarded on any style change, rebuild, navigation, or reload.
7. Widen is horizontal-only and a cycle; Full/Report have fixed width and no Widen.
8. `readOnly` is resolved once per load; edit-only chrome is not built, not merely hidden — but "Open in Workbench" and the heading are unconditional.
9. A menu's availability question is answered by a dry run of the real transform, never a duplicated rules copy — and a control must never open a confirmation only to refuse at the end of it.
10. A committed variable selection is never silently changed; an unfilled variable makes its panels wait, never run unfiltered.
11. Aborting/settling must preserve the last committed result rather than reverting to a placeholder; a presentation change must never cancel work.
12. Tree UI state must stay non-reactive and copy-on-write; drag feedback must cause no repaint.
13. The `fallback` slot is pinned to flow@1 and must never widen, even to another supported primary engine.

---

## 3. Navigation shell, schema/EXPLAIN graph, and reference panels

### Shipped & stable

**Shell frame** (`src/ui/app-shell.ts`) is the single owner of the persistent frame — header, auth host, banner, `.main-row` (left rail, sidebar, resize separator, query host, dashboard host), a visually-hidden live region, and mobile bottom nav. Exactly one of query/dashboard host is exposed at a time — the hidden one keeps its DOM and state (editor contents, tabs, result view all survive a Dashboard round trip).

**Left navigation — #487 Phases 1–3 are genuinely live today.** Pure layout core in `src/core/left-nav-layout.ts` (DOM-free): modes `wide | rail`, hysteresis-based fold/restore thresholds, a coherence invariant (`focusedSection` non-null only in rail mode), viewport clamping, and a three-layout resize session (`preferredAtStart` / `proposed` / `effective`) that keeps a viewport clamp from overwriting a stored preference. Section registry gives each of the four sections (Databases, Dashboards, Library, History) **one persistent host built once and never rebuilt** — switching sections only flips `hidden`, so search text, focus, tree expansion, and scroll all survive by construction. The rail is a real `<nav aria-label>` of four icon-only buttons with `aria-expanded` as the active-state driver. Focus continuity is **partially** handled already (drawer↔wide, drawer/wide→rail, Escape-to-launcher, desktop→mobile) — the remaining matrix is a committed target contract, below. Mobile presentation (segmented Explore/Library + 3-button bottom nav) is unchanged and out of #487's scope.

**Schema tree** (`src/ui/schema.ts`): databases → tables → columns with lazy column loading, cascading text filter (render-time only, never persists expansion), click = expand, double-click = insert, shift-click = SHOW CREATE; drag sources carry both identifier and schema-graph MIME payloads. Drag sources and hover tooltips are dropped entirely below the mobile breakpoint.

**Schema lineage graph and EXPLAIN pipeline graph** (`src/ui/explain-graph.ts`, layout via `@dagrejs/dagre` behind `app.Dagre`) share one pan/zoom interaction model: drag-to-pan, wheel-to-pan, ⌘/Ctrl+wheel zoom at cursor, double-click to fit. Inline EXPLAIN pipeline is plain pan/zoom; inline schema graph adds click-to-select (inserts SHOW CREATE) with ⌘/Ctrl+drag reserved for panning. A detached/fullscreen mode (real browser tab, or in-app overlay as fallback) adds ⌘/Ctrl+drag node repositioning with edge re-routing and full undo/redo. Node detail renders as a resizable strip docked at the **bottom** of the schema view (deliberately not right-side geometry) with "Open type/engine reference" buttons.

**Reference doc pane** (`src/ui/doc-pane.ts`): one persistent, non-modal, right-side pane, `role="complementary"`, no backdrop, independently resizable (`docPanePx`). States: loading / found / markdown-subset / disambiguation / missing / unavailable-with-Retry. A bounded 20-entry back stack; a token counter drops stale lookups; Escape closes only when focus is inside the pane and doesn't also cancel a running query.

**Library / History panels** (`src/ui/saved-history.ts`): a switcher over two independent hosts that (since #487 Phase 3) **both** always render their content regardless of which is exposed, each keeping its own filter text — so switching preserves both. Library rows: star, "Add to dashboard…", inline rename, delete, drag (as subquery and as a library-query reference). History rows: SQL preview, relative time, stats, delete, drag-as-subquery.

**What is NOT live today, despite being described in issues**: no rail drag-hover integration (#428), no right inspector at all (`src/ui/right-inspector.ts` doesn't exist on `main`), no documentation search.

### Committed target contracts (not yet fully live)

These are product/visual commitments independent of the #577/#578 implementation-architecture question — both #487 and #488 explicitly state that the behavior/contract is fixed and the implementation boundary is separately decided.

**#487 — left navigation.** Three desktop presentations, all participating in normal layout, never an overlay or backdrop:

```
wide           [two-pane sidebar] [main surface] [optional right inspector]
rail           [48px rail]        [main surface] [optional right inspector]
focused drawer [48px rail] [one docked section] [main surface] [optional right inspector]
```

Remaining committed work: (1) **structural focus continuity** — a full source→destination matrix (wide/drawer→rail lands on the matching rail launcher; rail/drawer→wide lands on the matching wide tab; Escape/launcher-close lands on the rail launcher; desktop→mobile lands on the active bottom-nav button; cancelled gestures preserve current focus); never steal focus after the user has moved, never land on `<body>` when a semantic destination exists. (2) **Separator discoverability** after a drawer closes — brief visual emphasis at the new location, honoring `prefers-reduced-motion`, no separate collapse button. (3) **Centre/right-panel reflow** — CodeMirror, result grid, Dashboard grids/charts, and the #488 inspector all need to react to available width, with viewport clamping never overwriting the preferred width. (4) **#428 drag-hover integration** — hovering a dragged Library query over Dashboards in rail mode opens the docked drawer.

**#488 — one foldable right inspector.** Replaces today's three unrelated right-side surfaces (non-modal doc pane, modal cell-detail drawer, modal rows viewer) with a single shell-owned docked inspector:

```
[folded]              [left nav] [main surface] [chevron]
[open]                [left nav] [main surface] [chevron] [right inspector]
[left drawer + open]  [rail] [left drawer] [main surface] [chevron] [right inspector]
```

One inspector host per shell; no backdrop, no centre coverage, no focus trap; **only one tool visible at a time** (`cell | rows | reference`), with valid inactive-tool state cached for the session. Fold control is one narrow vertical chevron on the inspector's left boundary (points left = "open" when folded, right = "fold closed" when open); stays visible at the right edge when folded; moves with the inspector's edge when open. Ownership split: shell owns host/geometry/active-tool/width/separator; tool controllers own payloads, validity, and async generation tokens. Cell/Rows invalidate on result replacement, rerun, tab close, workspace switch, or sign-out (stale async work must never repaint a newer payload); Reference survives Query-tab switching and most workspace changes, but not connection change or sign-out. Suggested geometry: inspector default 480px / min 320 / max 55% viewport, with a documented centre minimum that will need reconciling against the left-nav's own centre minimum (480px) once both exist together. `cellDrawerPx` and `docPanePx` collapse into one `rightInspectorPx` preference with a documented read-fallback order.

**#214 — type-aware cell-detail viewer.** Feeds #488. Modes `Auto | Text | JSON | SQL | Markdown | HTML | XML` (YAML explicitly out of scope) via a pure `analyzeCellValue()` descriptor replacing today's three-way `looksLikeHtml`/JSON-reindent/plain-`<pre>` logic. JSON formats locally; SQL formats only server-side (cancellable, bounded, cached); Markdown is never auto-detected. Source views route through the existing injected CodeMirror `CodeViewer` seam.

**#420–423 — server-backed documentation search.** Search describes only what the *connected* server exposes (version-exact, permission-aware, no remote index). One capability-generated `UNION ALL` over available system tables (`system.documentation`, `functions`, `formats`, `table_engines`, `database_engines`, `data_type_families`, `table_functions`), JS-owned deterministic ranking, explicit submission only (no search-as-you-type). New drawer body state with `aria-live` result-count announcement; Back-stack snapshot carries the full search state so Back never re-queries. Ranking refinement (#423) adds position/proximity/phrase bonuses and bounded match-centered snippets, deferred behind the baseline service (#421) and independent of the UI work (#422).

### Accessibility affordances and gaps

Shipped: the left-nav separator's full `role="separator"` + live `aria-value*` + status-region announcements; the rail's `aria-label`/`aria-controls`/`aria-expanded` per button; the drawer's conditional `aria-labelledby`; the Dashboard tree's `role="tree"`; the doc pane's `role="complementary"` and disambiguation list; `:focus-visible` rings on the rail buttons and separator.

Gaps a V2 should treat as open work:
- **Schema tree is pointer-only** — no `role="tree"`, rows have no `tabindex`/`role`/`aria-expanded`, so expand/collapse and insert are unreachable by keyboard; affordances communicate only through native `title` tooltips, which are dropped entirely on mobile.
- **Graph surfaces (schema lineage, EXPLAIN pipeline) have no semantics at all** — the `<svg>` has no `role`/`aria-label`, nodes have no `role="button"`/`tabindex`/accessible name, so selection, insertion, panning, zooming, and node repositioning are all pointer-only. The eight-kind legend conveys meaning by colour swatch alone.
- **Library/History rows are pointer-only** — only nested action buttons are tab-reachable, not the rows themselves.
- **Mobile nav conveys selection via CSS only** — no `aria-pressed`/`aria-current` on the segmented control or bottom nav, which matters because those are exactly the focus destinations #487's mobile transitions land on.
- **Three competing right-side surfaces coexist today** (non-modal doc pane alongside modal cell-detail/rows drawers with focus-trapping stacking) — precisely the fragmentation #488 exists to resolve into "one inspector, no backdrop, no focus trap."

---

## Cross-cutting themes for V2

A few patterns recur across all three surfaces above and are worth treating as first-class redesign inputs, not incidental detail:

- **"Listed but unavailable, never silently hidden" for menu-style controls** (Dashboard `⋯` menu, Save-conflict states) vs. **"absent, not disabled" for bare toolbar icons** — these are two deliberately different vocabularies for the same underlying idea (communicate why something can't be used), and a redesign should keep both, not collapse them into one pattern.
- **Pointer-only interaction is the single largest accessibility gap**, repeated near-identically in three places (result grid, schema/EXPLAIN graphs, Library/History rows). A V2 design system should solve this once (a shared focusable/keyboard-operable row or node primitive) rather than three times.
- **Every surface distinguishes persisted preference from transient/session state and is careful never to let the second corrupt the first** (layout spans/heights vs. preview spans, left-nav preferred width vs. viewport-clamped width, Dashboard variable values vs. tile results). A redesign that introduces new resizable/foldable surfaces (the right inspector chief among them) needs the same discipline from day one.
- **Right-side UI is actively consolidating** (#488 folding the doc pane, cell drawer, and rows viewer into one inspector) — a V2 visual design pass on any of those three surfaces individually would be premature; design the unified inspector contract instead.
- **Live-region/aria-live announcement is inconsistent**: some surfaces have it well (spec diagnostics, left-nav separator), others have none at all (query lifecycle, result grid sort state). Worth a single cross-cutting pass rather than per-surface patches — which is exactly #73's scope.
