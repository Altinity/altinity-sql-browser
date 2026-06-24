# Handoff: Altinity Play — Redesigned Query Workbench

## Overview

This is a redesign of the Altinity Antalya `/play-a` page (the ClickHouse-flavored
SQL playground at `https://antalya.demo.altinity.cloud/play-a`). The original
page is essentially a single textarea + Run button + results table. This redesign
turns it into a modern data workbench in the spirit of DataGrip / Postgres.app /
Linear — schema-first, multi-tab, with polished results, charts, and history.

The primary user is a **ClickHouse newcomer exploring the public demo data**;
the experience should feel approachable but still pro-grade.

---

## About the Design Files

The files in this bundle are **design references**. They are working HTML
prototypes built with React + Babel inline transpilation, intended to demonstrate
the intended **look, layout, behavior, and interactions** — not to be shipped as
production code.

**Your task is to recreate these designs in the target codebase's existing
environment** (the live `/play-a` app, presumably a React/Vue/Svelte SPA served
by ClickHouse + Altinity infra), using its established patterns, component
library, routing, styling solution, and data layer. If the project has no
existing frontend stack yet, choose the most appropriate framework — React +
Vite + TypeScript is a reasonable default — and implement there.

When you start, please:

1. Open `Altinity Play.html` in a browser to see the design live.
2. Read this README in full.
3. Skim the `.jsx` files for the exact structure, props, and interaction logic
   you'll need to mirror.
4. Identify the equivalent components/primitives in the target codebase before
   re-implementing from scratch.

---

## Fidelity

**High-fidelity.** All colors, typography, spacing, border radii, and
interactions are intentional and final. Recreate pixel-perfectly using the
codebase's existing libraries and patterns. Do not substitute "close enough"
values for the design tokens listed below.

The one exception: the syntax-highlighted SQL editor in the prototype is
hand-rolled (transparent textarea over a styled `<pre>` for highlighting). In
production, **swap this for Monaco Editor or CodeMirror 6** — it's expected
behavior, not a stylistic choice. Match the visual treatment (line gutter
style, font, line height, color palette) to what the prototype shows.

---

## Screen: Sign in (`Login.html`)

The connection/login screen shown before the workbench. Three auth paths,
encoded directly in the UI. Centered 400px card on the app's dark bg
(`radial` accent glow behind it), same tokens/fonts as the workbench.

**The rules (this is the important part):**
1. **SSO is the default.** A primary "Continue with SSO" button authenticates
   on **the current host** (the server serving the page —
   `CURRENT_HOST`, e.g. `otel.demo.altinity.cloud`). OAuth is configured
   per-deployment, so SSO is always bound to the current host — it does **not**
   honor the host override. Helper text states this.
2. **Credentials override SSO.** When username **and** password are both
   non-empty, the UI flips: **Connect** becomes the primary (accent) button and
   SSO demotes to a secondary (`btn-ghost`) outline — visually encoding "these
   are used instead of SSO." Enter submits; password has a show/hide toggle.
3. **Optional host:port override.** Under an **Advanced** disclosure (collapsed
   by default so the common SSO path stays clean): a single "Server address
   (host:port)" field. Blank → use the current host. A value → connect there
   **for the credential path only** (per rule 1, SSO ignores it).

**Live target summary**: a mono status row pinned near the bottom always
resolves the combined state — `Target: <effectiveHost>` on the left, and
`as <username>` (credential path) or `via SSO` on the right — so the
interaction of the three rules is never ambiguous. `effectiveHost =
hostOverride.trim() || CURRENT_HOST`.

**State / logic** (all local in the prototype):
- `hasCreds = username.trim() && password` → drives the primary/secondary swap
  and enables the Connect button.
- `effectiveHost` as above.
- `busy` ∈ {`'sso'`,`'creds'`,null} → button label becomes "Redirecting…" /
  "Connecting…". The prototype just times out after 1.6s; **wire to the real
  OAuth redirect / ClickHouse auth in production.**

**Production wiring:**
- **SSO** → kick off the existing OAuth flow against the current origin
  (the same one used today at `/sql`).
- **Credentials** → authenticate against ClickHouse at `effectiveHost`
  (HTTP interface; `Authorization: Basic` or `X-ClickHouse-User` /
  `X-ClickHouse-Key`). Validate host:port input; default the port if omitted
  (8443 https / 9440 native-secure as appropriate).
- Treat host override as untrusted input; constrain scheme/port as your
  security model requires.
- On success, hand off to the workbench (`Altinity Play.html` equivalent) with
  the resolved connection in context.

**Footer**: GitHub "Source" link + version chip, matching the workbench header.
**Tweaks**: theme + accent (same as the workbench), so the login matches
whatever palette the app ships with.

---

## Layout / Screens

There is one main screen — the workbench — composed of four regions:

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER (44px)                                                        │
├────────────────┬─────────────────────────────────────────────────────┤
│                │ TABS (34px)                                         │
│   SIDEBAR      ├─────────────────────────────────────────────────────┤
│   (resizable,  │ EDITOR TOOLBAR (38px)                               │
│   180–420px,   ├─────────────────────────────────────────────────────┤
│   default 248) │                                                     │
│                │ SQL EDITOR  (top half, default 45%)                 │
│   • Schema     │                                                     │
│   • Saved/Hist ├──────── 4px draggable splitter ─────────────────────┤
│   (vertical    │ RESULTS TOOLBAR (36px)                              │
│   split, 60/40)├─────────────────────────────────────────────────────┤
│                │ RESULTS PANE                                        │
│                │ (table / chart / json view toggle)                  │
└────────────────┴─────────────────────────────────────────────────────┘
                              ⇣
                  Floating Tweaks panel (dev tool;
                  not shipped to end users)
```

Editor-first split: the editor gets 45% of vertical space by default; the
horizontal splitter between editor and results is draggable (15–85%).

---

## Region 1: Header (44px tall)

Background: `--bg-header`. Bottom border: 1px `--border`.
Padding: `0 14px`. Flex row, 14px gap.

**Left cluster:**
- **Logo tile**: 22×22, `border-radius: 5`, gradient `linear-gradient(135deg,
  var(--accent), color-mix(in oklab, var(--accent) 70%, #000))`. White "A" inside,
  font-weight 700, 12px.
- **Wordmark**: "Altinity Play", 13px / 600 / `--fg`.
- **Connection chip**: `antalya.demo` in mono font, 11px / `--fg-faint`,
  `--bg-chip` background, padding `2px 6px`, radius 4. `white-space: nowrap`.

**Spacer (`flex: 1`)**

**Right cluster:** (`flex-shrink: 0`, `white-space: nowrap`)
- **Live status**: 7×7 green dot (`#22c55e`) with `box-shadow: 0 0 6px #22c55e`,
  followed by mono text "ClickHouse 26.3.10" at 11.5px / `--fg-mute`.
- **GitHub link** (`<a>`, github glyph): 26×26, transparent, hover `--bg-hover`.
  `target="_blank" rel="noopener noreferrer"`, `aria-label`/title "View on GitHub".
- **Shortcuts button** (`?` icon): 26×26, transparent, hover `--bg-hover`.
- **User menu**: avatar chip (24×24, radius 12, `--bg-chip`, initials "DM") +
  chevron, wrapped in a button. Click opens a dropdown (width 230) with:
  identity header (accent-filled 32px avatar, name, email), a role line
  ("Read-only · demo", mono, `--fg-faint`), and a red **Log out** item
  (`#ef4444`, `Icon.logout`). Clicking Log out opens a **confirmation dialog**
  (340px, centered, blurred backdrop) explaining that unsaved tabs stay in the
  browser and saved queries are kept, with Cancel / Log out (red) buttons.
  An invisible full-viewport overlay behind the dropdown closes it on outside
  click.

---

## Region 2: Sidebar (resizable, default 248px wide, min 180, max 420)

Background: `--bg-side`. Right border 1px `--border`. Vertical split into:

### 2a. Schema browser (top, ~60% height)

- **Search field**: 26px tall input with magnifier icon at left (12px, 8px from
  left edge). Placeholder "Search tables, columns…", 11.5px. `--bg-input`
  background, 1px `--border`, radius 5. Filters tree live.
- **Tree** (4px vertical padding, scrollable):
  - **Database row** (24px tall, 10px left padding + 14px per indent level):
    - Chevron (right when collapsed, down when expanded) at left.
    - Database icon, `--fg-mute`.
    - Name, 12px / 600 / `--fg`.
    - Child count, 10px mono / `--fg-faint`, right-aligned.
  - **Table row** (24px tall, indent 1):
    - Chevron if has columns.
    - Table icon in `--accent` color.
    - Name, 12px / 400 / `--fg-mute`.
    - Row count (e.g. "198.3M"), 10px mono / `--fg-faint`.
  - **Column row** (22px tall, indent 2):
    - Column icon, `--fg-faint`.
    - Name, 11px mono / `--fg-mute`. Click to insert into editor.
    - Type badge (e.g. "UInt16"), 10px mono / `--fg-faint`.
- Hover: `--bg-hover` background.
- Search-match highlight: `--bg-highlight` (translucent accent).

### 2b. Vertical resize handle (6px, `--border`, `cursor: row-resize`)

### 2c. Saved / History panel (bottom, ~40% height)

- **Tabs row** (30px): "★ Saved" and "⏱ History", each `flex: 1`, no border,
  underline 2px in `--accent` on active. 11.5px / 500.
- **Saved item**:
  - Padding `8px 10px`, 1px `--border-faint` bottom.
  - Star icon (filled if `starred`, in `--accent`); fallback `--fg-faint`.
  - Name, 12px / 500 / `--fg`, single line + ellipsis.
  - Below: SQL preview (first line), 10.5px mono / `--fg-faint`, 18px left
    indent, single line + ellipsis.
  - Click → opens as new tab.
- **History item**:
  - Padding `8px 10px`, 1px `--border-faint` bottom.
  - SQL preview, 11px mono / `--fg`, single line + ellipsis.
  - Below: meta row, 10px mono / `--fg-faint`, 10px gap: relative time, row
    count, ms.
  - Click → re-run as new tab.

---

## Region 3: Tabs row (34px)

Background: `--bg-tabs`. Bottom 1px `--border`.

- Each tab: 100px min-width, padding `0 8px 0 12px`, right border 1px.
- Active tab: background `--bg-editor`, name 11.5px / 500 / `--fg`, **2px top
  bar in `--accent`** (absolutely positioned).
- Inactive tab: `--fg-mute`, 400 weight.
- Tab name + (if dirty) 5px gray dot + (if multi) 16×16 close × button.
- **+ button** at far right: 32px wide, 1px left border, plus icon centered,
  `--fg-mute` → `--fg` on hover. ⌘T also creates new tab.

---

## Region 4: Editor toolbar (38px)

Background: `--bg-toolbar`. Bottom 1px `--border`. `0 10px` padding, 8px gap.

- **Run button**:
  - 26px tall, padding `0 10px 0 8px`.
  - Background: `--accent`, color: white.
  - 11.5px / 600. Radius 5.
  - Icon (play triangle) + "Run" + small `⌘↵` kbd inside (rgba(0,0,0,.2) bg,
    9.5px mono).
  - Disabled (running) state: opacity 0.7, label "Running…", cursor wait.
- **Format button**: tb-btn class — transparent, `--fg-mute` → `--fg` on hover,
  `--bg-hover`. Has `{ }` mono glyph + "Format". `white-space: nowrap`.
- **Spacer**
- **Share button**: tb-btn, share-graph icon + "Share".
- **Format select**: dropdown for output format (TSV/CSV/JSON/Pretty), 1px
  `--border` outline, custom chevron SVG.

---

## Region 5: SQL Editor

- Mono font: `'JetBrains Mono', 'SF Mono', ui-monospace, monospace`. 13px (12.5px
  in compact density). Line-height 1.7 (1.5 compact). Padding `12px 14px` (8px
  vertical in compact).
- Background: `--bg-editor`. Caret color: `--accent`.
- **Line gutter**: 44px wide, right-aligned, padding `padY 8px padY 0`. Text
  `--fg-faint`, mono, tabular-nums. Right border 1px `--border`. Background
  `--bg-gutter`. Scrolls in lockstep with the editor.
- **Tab key** inserts 2 spaces. (When swapping in Monaco/CodeMirror, this is
  handled natively.)

### SQL syntax highlight palette

| Token   | Dark         | Light      |
|---------|--------------|------------|
| keyword | `#C586C0` 500| `#AF00DB`  |
| func    | `#DCDCAA`    | `#795E26`  |
| string  | `#CE9178`    | `#A31515`  |
| number  | `#B5CEA8`    | `#098658`  |
| comment | `#6A9955` italic | `#008000` italic |
| ident   | `--fg`       | `--fg`     |
| op      | `--fg-mute`  | `--fg-mute`|

Keyword and function lists are in `sql-editor.jsx` (`SQL_KEYWORDS`, `SQL_FUNCS`)
— they include the ClickHouse-flavored set (e.g. `PREWHERE`, `FINAL`,
`toStartOfMonth`, `LowCardinality`, etc.).

### 5b. Editor enhancements (issues #23–#27)

Reference designs for the editor-enhancement track, all built on the existing
**textarea-over-`<pre>`** surface (no editor library). Files: `editor-data.jsx`
(reference data), `editor-search.jsx` (#23), `editor-complete.jsx` (#26/#27),
and the rewired `sql-editor.jsx`. The prototype implementations are the visual
spec; production keeps the same UX but sources data from ClickHouse system
tables (see #25).

**The keystroke rule (load-bearing):** none of these run SQL on the keystroke
path. Autocomplete/hover/signature all read **in-memory reference data** fetched
once per connection. Honor this in production.

#### #23 — Find / replace (`editor-search.jsx`, `SearchPanel` + `findMatches`)
- **Trigger**: `Cmd/Ctrl+F` bound on the **textarea keydown** (not a global
  shortcut) so the browser's native find can't intercept it first.
- **Panel**: floating, top-right of the editor. Find row = input + match counter
  (`3/12`), prev/next, and three toggles — **Aa** case, **W** whole-word,
  **.*** regex (active toggle filled with `--accent`). A disclosure chevron
  expands the **Replace** row (input + Replace + Replace-all).
- **Highlights**: drawn by a **second `color:transparent` `<pre>` overlay**
  (`MarkOverlay`) layered *below* the token `<pre>`, carrying only background
  spans — the token render path (`SqlHighlighter`) is never touched, exactly as
  resolved in the issue. All matches use a translucent accent bg; the active
  match a stronger accent. Same padding/font/scroll-sync as the other layers.
- **Keys**: Enter = next, Shift+Enter = prev, Esc = close. Invalid regex →
  counter shows "bad re", red field border, no marks.
- **Behavior**: `findMatches(value, query, {caseSensitive, wholeWord, regex})`
  returns `{start,end}[]`; navigation scrolls the textarea to center the active
  match.

#### #24 — Bracket matching + auto-close (`sql-editor.jsx`)
- **Match highlight**: when the caret is adjacent to a bracket, both it and its
  partner get an accent bg (via the same `MarkOverlay`). `matchBracketAt`
  scans with nesting depth in either direction.
- **Auto-close**: typing `(` `[` `{` inserts the pair and puts the caret
  inside. Quotes `'` `"` `` ` `` auto-close too (double-quote included per the
  resolved decision; `{`/`}` JSON context deliberately *excluded* from 1b).
- **Wrap selection**: with text selected, typing an opener wraps the selection —
  `(selected)`.
- **Type-over**: typing a closing bracket/quote when the next char is already
  that char just steps over it.
- **Pair-delete**: Backspace inside an empty `()`/`''` removes both.

#### #25 — Dynamic reference data + tokenizer API (`editor-data.jsx`)
- **Tokenizer API**: `tokenize(sql, { keywords, funcs } = {})` — optional second
  arg, backward-compatible (existing callers pass nothing → built-in sets). Lets
  the server's `system.keywords` / `system.functions` drive highlighting so it's
  version-correct.
- **Reference payload** (`REF_KEYWORDS`, `REF_FUNCTIONS`, `REF_KEYWORD_DOCS`):
  keyword list, function signatures + return types + descriptions, keyword docs.
  `buildCompletions(schema)` merges these with the in-memory schema (databases,
  tables, and **only already-loaded columns** — no on-demand column fetch from
  the completion path) into a flat candidate list.
- **Production**: load once per connection from `system.{keywords,functions,
  completions,documentation}`, cache in memory for the session (localStorage
  deferred until server-version-keyed invalidation is designed).

#### #26 — Autocomplete dropdown (`editor-complete.jsx`, `AutocompleteDropdown`)
- **Trigger**: typing word chars (≥1) or right after a `.`. `completionContext`
  finds the word under the caret and whether it's **qualified** (`table.` →
  only that table's columns).
- **Ranking** (`rankCompletions`): prefix matches before substring; schema
  (columns/tables) boosted; capped to 50. Empty word after no dot →
  keywords + tables only.
- **UI**: 350px popover at the caret (flips above when near the bottom). Each row
  = a kind glyph chip (keyword `K` / function `ƒ` / aggregate `Σ` / cast `⇄` /
  table `▦` / column `▪` / db `◈`, each color-coded), the label with the typed
  substring bolded in accent, and a right-aligned detail (signature / type /
  "table · N rows"). A footer shows the active item's signature → return type
  and description.
- **Keys**: ↑/↓ move, Enter/Tab accept, Esc dismiss; mouse click accepts.
  Functions insert `name(`. Accepting replaces the `[from,to]` word range.

#### #27 — Signature help + hover docs (`editor-complete.jsx`)
- **Signature help**: while the caret is inside `fn(…)`, a popover above the
  caret shows the signature with the **active argument bolded** (arg index from
  `signatureContext`, which walks back counting commas at depth 0) and the return
  type. Hidden while the autocomplete dropdown is open.
- **Hover docs**: hovering a function or documented keyword (~350ms dwell) shows
  a `HoverCard` with signature → return and description. Position is mapped from
  mouse XY back to a token via `posFromXY` + `wordAt`. Phase 2c / optional;
  in production source docs from `system.documentation` (load upfront with #25,
  or lazily on first hover — open question).

**Geometry note:** caret/hover positioning uses a monospace fast-path
(`charWidthFor` via canvas + line/col arithmetic) rather than a mirror div,
valid because the editor is `white-space: pre` in a monospace font. If a
proportional font or wrapping is ever introduced, switch to a mirror-div
measurement.

**Not buildable on a textarea** (correctly deferred to the CodeMirror track,
#21): code folding and multi-cursor — one caret, no line hiding.

---

## Region 6: Results pane

### 6a. Results toolbar (36px)

Background `--bg-toolbar`. Bottom 1px `--border`. `0 10px` padding, 10px gap.

- **View segmented control** (3 options: Table / Chart / JSON):
  - Container: `--bg-chip`, 5px radius, 2px padding.
  - Each segment: 22px tall, 10px x-padding, 4px radius. Active: `--bg-editor`
    bg, `--fg` text, 500 weight, subtle 1px shadow. Inactive: `--fg-mute`, 400.
  - Each segment shows icon + label.
- **Spacer**
- **Stat chips** (right-aligned, separated by 1px `--border-faint`):
  - clock icon + ms (e.g. "218 ms")
  - rows icon + row count (e.g. "15 rows")
  - bytes icon + scanned bytes (e.g. "2.41 GB"), title attr shows scanned row
    count.
  - 11px mono, `--fg-mute` for icons, `--fg` for values.
- **Copy button** (tb-btn): copy icon + "Copy"
- **Export button** (tb-btn): download icon + "Export"

### 6b. Empty state

When no result and not running: centered column with a 36×36 `--bg-chip` circle
holding a faded play icon, then the message "Press `⌘↵` to run query" with a
styled kbd.

### 6b-running. Query-running state — progressive streaming (no blocking loader)

While a query is in flight, **do not** block the pane with a full-screen
spinner. Instead **stream partial results into the table as they arrive** and
show live counters in the results toolbar. Showing data-so-far is materially
better UX than a spinner, and it mirrors how ClickHouse actually returns data.

**Results toolbar while running** (replaces the static stats):
- **Live counters**, rendered in `--accent`, mono:
  - clock/spinner + **elapsed ms**, ticking smoothly off a local
    `performance.now()` clock (~50ms interval).
  - rows icon + **rows read so far** (`fmt()` → 7.7M / 64.1M-style humanized).
  - bytes icon + **bytes scanned so far**.
- **Cancel** button (replaces Copy/Export while running): `Icon.close` +
  "Cancel" + an `Esc` kbd. Hover turns red (`#ef4444`). **Esc also cancels**
  (global key handler).

**Results body while running:**
- The **table renders the partial rows** that have streamed in (columns appear
  immediately; rows fill progressively). Before the first batch, a brief
  centered "Starting query…" with a small spinner (`EmptyResults streaming`).
- A 2px **streaming strip** pins to the top of the body: an `--accent` fill at
  `read / total` when totals are known, otherwise an indeterminate sweep
  (`runsweep` keyframes).

**On cancel:** stop the stream, **keep whatever rows already arrived**, and mark
the result `cancelled`. The toolbar then shows a red **"Cancelled · partial"**
badge next to the (frozen) final stats, and Copy/Export re-enable on the partial
set.

**Production wiring:** drive the streamed rows + counters from ClickHouse's
**`X-ClickHouse-Progress`** headers (rows/bytes read + total estimate) and the
streamed result body; wire **Cancel** / Esc to **`KILL QUERY`**. The prototype
simulates the stream in `app.jsx` → `runQuery` (partial-row slices on a timer)
and `cancelQuery`. A **"Slow query (~9s)"** toggle under Tweaks → Demo only
slows the simulation so the streaming is easy to observe — no production
meaning; remove it in the real build.

### 6c. Table view

- Mono font, 11.5px.
- `border-collapse: collapse`. Width `max-content`, min `100%`.
- **Header row** (`thead` is `position: sticky; top: 0`):
  - 36px wide `#` column, centered, `--fg-faint`.
  - Each data column: min-width 140px. Cell padding `7px 12px` (4px 10px in
    compact). Background `--bg-th`. Font 11px / 500 / `--fg-mute`.
  - Inside each cell: column name in `--fg`, then type badge in 9.5px /
    `--fg-faint`. Spacer. If this column is the active sort, sort arrow in
    `--accent`. Click toggles asc → desc → asc.
- **Data row**:
  - Hover: `--bg-hover` on every cell.
  - Number cells: right-aligned, color `--num` (`#92E1D8` dark / `#0F766E`
    light), shown to 2 decimals.
  - String cells: left-aligned, `--fg`.
  - **Special case**: column 0 in the demo result is an airline code like
    "B6". Render as `<code>B6</code>` followed by faded carrier name (`JetBlue`,
    etc) in `--fg-faint`. The lookup table is in `data.jsx` (`CARRIER_NAMES`).
    In production, this should be a more general "dimension display" extension
    (e.g. allow saved queries to declare lookup mappings).
  - All cells: 1px `--border-faint` right + bottom borders.

### 6d. Chart view (bar)

For 2-column results where col 0 is a dimension and col 1 is a number.

- Padding `20px 24px`. Background `--bg-table`.
- Title: "{col1.name} by {col0.name}", 11px mono / `--fg-mute`, 14px bottom.
- Each row, 18px tall:
  - Label cell: 110px wide, mono, right-aligned. Code in `--fg`, expanded name
    in `--fg-faint` (same dimension treatment as the table).
  - Bar track: `flex: 1`, 18px tall, `--bg-chip` bg, 2px radius.
  - Bar fill: gradient `linear-gradient(90deg, var(--accent),
    color-mix(in oklab, var(--accent) 65%, transparent))`. Width = (value /
    max) * 100%. Transition `width .4s cubic-bezier(.2,.7,.3,1)`.
  - Value cell: 70px wide, mono, right-aligned, `--num`, 2 decimals.

For other shapes (single-series line, pie, multi-series), follow the same
visual language: accent-tinted, mono labels, dim grid, no chartjunk. Use
visx / Recharts / d3 / Apache ECharts — whatever the codebase has.

#### Implementing Chart view in production (answer to Boris)

> **Now built in the prototype.** `ResultsChart` in `components.jsx` implements
> the config bar + `autoChart()` defaults + SVG renderers + an HTML horizontal-bar
> renderer (Bar=horizontal/Column=vertical/Line/Area/Pie, multi-series, group-by).
> `autoChart` defaults categorical X → **horizontal Bar** (the ranked-list view
> from the first design — best for category comparisons), temporal X → Line,
> ordinal X → Column. `data.jsx` adds `RESULT_MONTHLY` (temporal → Line) and
> `RESULT_DOW` (ordinal) demo sets, and `pickResult(sql)` chooses one by
> inspecting the SQL so Bar↔Line is demonstrable. The renderers are
> prototype-grade — **swap for a real charting library in production** (below);
> keep the config-bar UX, the `autoChart` heuristic, and horizontal-bar default.

The prototype's chart is deliberately the *minimum*: a CSS-only horizontal bar
chart hardwired to `col[0]=dimension, col[1]=measure` (see `ResultsChart` in
`components.jsx`). It demonstrates the look, not the real capability. Here's how
to build the production version.

**1. Don't hand-roll it — use a charting library.** CSS bars don't scale to
line/area/pie, axes, tooltips, legends, log scales, or thousands of points.
Pick one already in (or acceptable to) the codebase:
- **Apache ECharts** — best for large/dense data and many chart types
  (canvas-rendered, handles 10k+ points, built-in zoom/tooltip). Recommended
  default for a data tool.
- **Recharts / visx** — fine if the app is React-first and datasets stay small
  (SVG; gets heavy past a few thousand points).
- **Observable Plot** — terse grammar-of-graphics, great for quick exploratory
  charts.

**2. Infer column roles from ClickHouse types, then let the user override.**
The result already carries `{name, type}` per column — use the type to
classify, don't guess from values:
- **Measures (Y / value)**: numeric types — `Int*`, `UInt*`, `Float*`,
  `Decimal*`.
- **Temporal (X, ordered)**: `Date`, `Date32`, `DateTime`, `DateTime64`.
- **Dimensions (X / category / series)**: `String`, `LowCardinality(String)`,
  `Enum*`, `Bool`.
- Strip `Nullable(...)` / `LowCardinality(...)` wrappers before classifying.

Auto-pick a sensible default encoding (first temporal or dimension → X; first
measure → Y), then expose a small **chart-config bar** above the plot so the
user can change it. That config is the real feature:
- **Chart type**: Bar / Line / Area / Pie / (Scatter). Default by data shape:
  temporal X → line; categorical X → bar; single dimension + single measure and
  ≤ ~12 rows → pie is allowed.
- **X axis** (dropdown of columns), **Y axis / measures** (one or many numeric
  columns → multi-series), optional **Series/Group-by** (a dimension column →
  splits into multiple lines/stacked bars).
- Persist the chosen config per query tab.

**3. Map result → chart data.** Transform the `rows: any[][]` + `columns[]` into
the library's series format using the encoding above. For multi-series, pivot on
the series column. Coerce `DateTime` strings to real dates for time axes.

**4. Theme it to the tokens** so charts match the app in both themes:
- Series color: `--accent` (single series); for multi-series derive a small
  palette by rotating hue off the accent (e.g. OKLCH hue steps) rather than a
  random rainbow.
- Axes / grid: `--border` / `--border-faint`; labels `--fg-mute`, mono font
  (`--mono`); tooltip surface `--bg-modal` + `--border`.
- No gradients-as-decoration, no drop shadows, no 3D — keep the dense/technical
  look.

**5. Handle the realities of query output:**
- **No chartable columns** (e.g. all strings, or a single column) → show an
  empty-state hint ("Add a numeric column to chart these results"), not a broken
  axis.
- **Too many points** → the chart engine should downsample/aggregate, or prompt
  to add `LIMIT` / `GROUP BY`. ECharts' `large` mode or server-side bucketing
  handles this.
- **Streaming**: only render the chart on completed (or paused) result sets;
  re-rendering a chart on every streamed batch is wasteful — update the table
  live, build the chart when the stream settles.
- Respect the current sort, and format numbers like the table (`--num`, 2
  decimals / humanized).

**6. Keep the toggle contract.** Chart is one of the three result views
(Table / Chart / JSON segmented control). Selecting it swaps the body only; the
results toolbar (stats, copy/export) stays. "Export" on a chart view can offer
PNG/SVG in addition to the data formats.

### 6e. JSON view

- `<pre>` over the full pane, padding `14px 16px`.
- 11.5px mono, `--fg`, on `--bg-table`. Pretty-printed (2-space indent).
- Built from the sorted rows + column names.

---

## Region 7: Tweaks panel (dev tool — DO NOT SHIP TO END USERS)

This is a design-time controls panel from our prototyping kit. It exists so the
designer can tweak theme/accent/density/sidebar live. It's **not part of the
end-user product**.

If you want a similar end-user "preferences" surface, that's a separate spec —
ask before adding.

---

## Region 8: Shortcuts modal (`?` to open)

- 480px wide centered modal, `--bg-modal` background, 1px `--border`, 10px
  radius. Backdrop: `rgba(0,0,0,.5)` + 4px blur.
- Title "Keyboard shortcuts", 14px / 600.
- 3 groups (Editor, Navigation, Results) — each a small section header (10px /
  600 / uppercase / `.06em` letter-spacing / `--fg-faint`) followed by rows.
- Row: label in `--fg-mute` left, kbd badge right (10.5px mono, `--bg-chip`
  bg, 4px radius, `--fg`).
- Click outside closes. The exact shortcut list is in `components.jsx`
  → `ShortcutsModal`.

---

## Interactions & behavior

- **⌘↵ / Ctrl↵**: run query.
- **⌘T / Ctrl T**: new tab.
- **⌘W / Ctrl W**: close tab. (Wired to UI close × button; bind globally.)
- **?**: toggle shortcuts modal (only when not in input/textarea).
- **Click column in schema** → inserts column name at end of active tab's SQL.
  In production, prefer "insert at cursor" via the editor's native API.
- **Click table row in saved/history** → opens the SQL as a new tab.
- **Tab dirty state**: any edit since load → small dot next to the tab name.
  Save logic isn't designed yet — saved queries are a read-only catalog in
  the prototype. Define save UX with the team.
- **Run query** flow in the prototype just sleeps 600ms and returns the canned
  result. In production, post to the ClickHouse HTTP interface
  (`POST /?database=…` with `X-ClickHouse-Format` header) and stream/parse
  results. Show running spinner state on the Run button (already wired —
  `running={running}` prop).
- **Sort columns**: clicking a header cycles asc → desc → asc (no neutral
  state in the prototype). For real datasets larger than what's loaded,
  re-issue the query with `ORDER BY` rather than client-sorting.
- **Splitter drags**: editor/results split clamps to 15–85%. Sidebar width
  clamps 180–420.
- **Resizable sidebar inner split** (schema vs saved/history) — currently
  uses flex; consider making it draggable too if users ask.
- **Search in schema**: filters by substring across table and column names.
  Tables that don't match but have matching columns stay visible (auto-expand).
  Persist? — open question.

---

## Design Tokens

All theme tokens live as CSS custom properties on the `[data-theme='dark']` /
`[data-theme='light']` selectors. They drive every surface, border, and
text color in the design.

### Dark theme (default)

| Token | Value | Purpose |
|-------|-------|---------|
| `--bg`           | `#0E0E10` | App background |
| `--bg-header`    | `#131316` | Header & sidebar bg |
| `--bg-side`      | `#131316` | Sidebar bg |
| `--bg-tabs`      | `#131316` | Tabs row |
| `--bg-toolbar`   | `#15151A` | Editor + results toolbars |
| `--bg-editor`    | `#0E0E10` | Editor pane |
| `--bg-gutter`    | `#131316` | Editor line numbers |
| `--bg-table`     | `#0E0E10` | Results surface |
| `--bg-th`        | `#15151A` | Table header |
| `--bg-input`     | `#1A1A20` | Inputs |
| `--bg-chip`      | `#1F1F26` | Chips, segmented control track |
| `--bg-hover`     | `rgba(255,255,255,.04)` | Generic hover |
| `--bg-highlight` | `rgba(255,107,53,.08)` | Search match |
| `--bg-modal`     | `#1A1A20` | Modal surface |
| `--fg`           | `#E6E6E8` | Primary text |
| `--fg-mute`      | `#A0A0A8` | Secondary text |
| `--fg-faint`     | `#6B6B74` | Tertiary text / icons |
| `--num`          | `#92E1D8` | Numeric values in tables/charts |
| `--border`       | `#1F1F26` | Hard borders |
| `--border-faint` | `#1A1A20` | Soft cell/row dividers |

### Light theme

| Token | Value |
|-------|-------|
| `--bg`           | `#FAFAFA` |
| `--bg-header`    | `#FFFFFF` |
| `--bg-side`      | `#F5F5F4` |
| `--bg-tabs`      | `#F5F5F4` |
| `--bg-toolbar`   | `#FAFAF9` |
| `--bg-editor`    | `#FFFFFF` |
| `--bg-gutter`    | `#FAFAF9` |
| `--bg-table`     | `#FFFFFF` |
| `--bg-th`        | `#F5F5F4` |
| `--bg-input`     | `#FFFFFF` |
| `--bg-chip`      | `#EEECE8` |
| `--bg-hover`     | `rgba(0,0,0,.04)` |
| `--bg-highlight` | `rgba(255,107,53,.12)` |
| `--bg-modal`     | `#FFFFFF` |
| `--fg`           | `#1A1A1F` |
| `--fg-mute`      | `#57575E` |
| `--fg-faint`     | `#94949C` |
| `--num`          | `#0F766E` |
| `--border`       | `#E5E3DE` |
| `--border-faint` | `#EEECE7` |

### Accent

`--accent` is a **theme-independent** brand color — same in dark and light:

- **Default (Altinity orange)**: `#FF6B35`
- Quick swatches in the design: `#FF6B35`, `#F0A500`, `#FFC700`, `#3B82F6`,
  `#10B981`, `#EC4899`. The color picker stores the value; UI uses it
  everywhere — Run button, table top accent, sort arrow, chart bars, search
  highlight, logo gradient base.

### Typography

| Family | CSS |
|---|---|
| UI    | `'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif` |
| Mono  | `'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace` |

Type ramp (px / weight):
- Modal title: 14 / 600
- Sidebar header rows / tab name: 13 / 600 / 11.5 / 500
- Body button: 11.5 / 500–600
- Secondary text: 11 / 400
- Small caps section labels: 10 / 600 / uppercase / `.06em` letter-spacing
- Table cells / SQL editor: 11.5–13 mono / 400

### Spacing & radii

- Heights: header 44, tabs 34, toolbars 36–38, control buttons 26, segmented
  control items 22, tree rows 22–24.
- Padding: page rails `0 14px`, region toolbars `0 10px`, table cells
  `7px 12px` comfortable / `4px 10px` compact.
- Radii: 4 (small chips, kbd), 5 (buttons, inputs, selects), 10 (modal), 12
  (avatar circle).
- Shadows: very restrained. The active segment in the segmented control gets
  `0 1px 2px rgba(0,0,0,.15)`. The modal: `0 20px 60px rgba(0,0,0,.4)`. The
  status dot: `0 0 6px #22c55e`.

### Density

`compact` reduces editor line-height (1.7→1.5) and font (13→12.5), tabs row
(34→28), and table cell padding (7×12 → 4×10). `comfortable` is default.

---

## State Management

Minimal, all local:

- `tabs: Tab[]` — open query tabs (id, name, sql, dirty).
- `activeId` — id of focused tab.
- `result` — current result-set (canned in prototype). In production: tied
  to the active tab; cache last result per tab so switching tabs doesn't lose
  it.
- `running: bool` — query in flight.
- `shortcutsOpen` — modal toggle.
- Pane sizes — `editorPct` (vertical split %), `sidebarPx` (sidebar width).

Persisting to URL/local storage suggestions:

- The currently-loaded SQL → URL hash (so a query is shareable). The "Share"
  button should generate this URL.
- Sidebar/editor split sizes → localStorage.
- Theme/density/accent → localStorage (or user account settings).

## Data fetching

Replace `runQuery` (currently a 600ms timeout) with the actual ClickHouse HTTP
call:

```
POST {clickhouse-base}/?database={db}&default_format=JSONCompactEachRowWithNamesAndTypes
Authorization: Basic …  // or whatever the existing /play uses
Content-Type: text/plain

{sql}
```

`JSONCompactEachRowWithNamesAndTypes` returns a streaming format that's easy
to render into the table without re-parsing. The result-set shape used by
the prototype (`{ columns: [{name, type}], rows: any[][], meta: {ms, rows,
scanned, scannedRows}}`) maps cleanly: take the first two streamed objects
as names + types, the rest as rows, and read the `X-ClickHouse-Summary`
response header for stats.

---

## Schema for the "schema browser" data

Currently hardcoded in `data.jsx` (`SCHEMA`). In production, fetch from
ClickHouse:

```sql
SELECT database, name, total_rows, total_bytes
FROM system.tables
WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema')
ORDER BY database, name

-- and for columns when a table is expanded:
SELECT name, type
FROM system.columns
WHERE database = ? AND table = ?
ORDER BY position
```

Lazy-load columns on table expand; cache per session.

---

## Saved queries & history

The prototype hardcodes both. In production:

- **Saved queries**: persist per-user to wherever Altinity Antalya stores user
  state. Schema: `{id, name, sql, starred, created_at, updated_at}`.
- **History**: write every executed query to a per-user log (capped, e.g. last
  500) with `{sql, started_at, duration_ms, rows, error}`.

> **Note on the current implementation:** saved queries live in browser
> `localStorage` today. That makes them per-browser-profile — lost on a cache
> clear, invisible on the user's other devices, and unshareable. The
> export/import feature below is the agreed interim mitigation; account-backed
> server storage is the eventual answer (and even then, export survives as a
> backup / portability / no-lock-in feature, so this work is not throwaway).

### Export / Import saved queries (JSON)

**Goal:** let users back up, transfer between machines/browsers, and share
their saved-query library. **JSON is the canonical format** — it round-trips
losslessly (export → import reproduces the library exactly).

(Decisions already made with the team: **JSON only** for round-trip
import/export. Markdown may be added later as an *export-only* "share" format.
CSV/TSV were explicitly rejected — SQL payloads contain newlines/commas/quotes
that delimited formats handle badly.)

#### File envelope

Export the whole library (or a user-selected subset) as a single `.json` file.
Wrap the array in a versioned envelope so the format can evolve:

```json
{
  "format": "altinity-sql-browser/saved-queries",
  "version": 1,
  "exportedAt": "2026-06-21T17:52:53.000Z",
  "queries": [
    {
      "id": "q_8f3a1c",
      "name": "Worst-delay carriers (2023)",
      "sql": "SELECT Reporting_Airline, avg(DepDelayMinutes) AS avg_delay\nFROM airline.ontime\nWHERE Year = 2023 AND Cancelled = 0\nGROUP BY Reporting_Airline\nORDER BY avg_delay DESC\nLIMIT 15",
      "starred": true,
      "createdAt": "2026-05-02T09:14:00.000Z",
      "updatedAt": "2026-06-10T12:31:00.000Z"
    }
  ]
}
```

- `format` + `version` let the importer reject foreign/garbage files and
  migrate older exports. Bump `version` on any breaking schema change.
- `id` should be **stable** (don't regenerate on every save) — it's what makes
  re-import idempotent (see merge rules).
- Suggested filename: `sql-browser-queries-YYYY-MM-DD.json`.

#### Export UI

- Primary: **Export all** → downloads the envelope above.
- Nice-to-have: multi-select in the Saved list → **Export selected**. Same
  envelope, filtered `queries[]`.
- **Placement**: Export + Import are a two-button row **pinned at the bottom of
  the Saved panel** (top border, `flex-shrink: 0`), below the scrolling query
  list — not at the top. The import-result toast ("Added N · updated N ·
  skipped N") appears just above the bar.
- Implementation: serialize → `Blob` → `URL.createObjectURL` → anchor download.
  No backend needed.

#### Import UI + merge rules (this is the real design work)

Export is trivial; **import is where the decisions live.** On file pick:

1. **Validate** — parse JSON; reject if `format` doesn't match or `version` is
   newer than the app understands. Validate each query's shape. Cap count/size
   (e.g. ≤ 1000 queries, ≤ 1 MB) to avoid abuse.
2. **Treat SQL as untrusted text** — never auto-run an imported query. It only
   ever runs later when the user explicitly hits Run.
3. **Collision handling** — for each incoming query, match against the existing
   library **by `id`**:
   - *No match* → add as new.
   - *Match, identical `sql` + `name`* → skip (no-op; makes re-import
     idempotent).
   - *Match, differs* → resolve via the user's chosen strategy. Offer at minimum:
     **Skip**, **Overwrite**, **Keep both** (import gets a new id +
     "(imported)" suffix on the name). A per-conflict prompt is ideal; a
     single global choice is the acceptable MVP.
   - If `id`s aren't trustworthy across installs, fall back to matching on a
     **hash of normalized SQL**, or on `name`.
4. **Partial import** — show a preview list with checkboxes so users import a
   subset, not all-or-nothing. MVP can skip this and import everything.
5. **Report** — after import, summarize: "Added 6, updated 2, skipped 3."

#### Markdown export (future, export-only)

If/when a "share" export is added: render each query as a `## {name}` heading
followed by a fenced ` ```sql ` block — renders perfectly in GitHub/wikis as a
"query cookbook." **Do not** rely on parsing it back; metadata (starred,
timestamps) doesn't survive without per-query YAML frontmatter, at which point
JSON is the better round-trip format. Keep Markdown strictly one-directional.

---

## Assets

- **Inter** and **JetBrains Mono** fonts loaded from Google Fonts in the
  prototype. Self-host in production for performance/privacy.
- **Icons** are inline SVGs in `components.jsx` → `Icon` map. Replace with
  the codebase's icon library (lucide / phosphor / heroicons / etc.) using
  the closest equivalents — they're all standard glyphs (chevron, database,
  table, columns, play, star, plus, close, search, history, download, share,
  copy, sortAsc, sortDesc, filter, clock, rows, bytes, etc.).

---

## Files in this bundle

- `Altinity Play.html` — entry point. Open in a browser to see the design.
- `Login.html` — the sign-in / connection screen (SSO + credentials + optional
  host:port override). Self-contained; imports `tweaks-panel.jsx`.
- `app.jsx` — top-level `<App />` component, layout assembly, splitters,
  global keyboard handlers.
- `components.jsx` — header, schema tree, saved/history panel, query tabs,
  editor toolbar, results pane (table/chart/json), shortcuts modal, icon
  set.
- `sql-editor.jsx` — the syntax-highlighted SQL editor (textarea over `<pre>`)
  + the editor enhancements (#23–#27): tokenizer dynamic-keyword API, bracket
  matching/auto-close, find/replace wiring, autocomplete + signature + hover
  wiring, caret geometry. **In production, the editing surface can stay as-is
  for #23–#27; folding/multi-cursor need CodeMirror (#21).** Keep the visual
  treatment (colors, gutter, font).
- `editor-data.jsx` — reference data (keywords, function signatures/docs,
  `buildCompletions`). Load from ClickHouse system tables in production (#25).
- `editor-search.jsx` — find/replace panel + `findMatches` (#23).
- `editor-complete.jsx` — autocomplete dropdown, signature help, hover card,
  and their context/ranking helpers (#26/#27).
- `data.jsx` — sample schema, saved queries, history, and a canned result-set
  (worst-delay carriers query against the airline ontime dataset).
- `tweaks-panel.jsx` — design-time controls. **Not part of the end-user
  product.**

---

## Resolved since first handoff

Decisions made with the team after the initial spec (implemented in the live
app — recorded here so the README stays the source of truth):

- **Save UX** — "Save" button in the editor toolbar (+ ⌘S) opens a name
  popover; saved items appear in the ★ Saved list with inline rename (pencil),
  delete (trash), and star toggle. Implemented.
- **Format button** — pretty-prints SQL (⌘⇧F). Prototype uses a hand-rolled
  formatter; production should use `sql-formatter` or the editor's native
  format action.
- **Column resize** — implemented in the live app.
- **Column types in result header** — **removed by design.** Stored-column
  types already live in the schema browser, so repeating them in the result
  header is duplication. Trade-off: **computed/aliased columns**
  (`avg(...) AS x`, `count()`, JOIN outputs) have their type nowhere else —
  recommend exposing type on **hover** of the result column name to cover that
  case without re-adding the duplication.
- **GitHub link** — added to the header. Give it `aria-label="View source on
  GitHub"` and `target="_blank" rel="noopener"`.
- **User menu / Log Out** — header avatar is a button opening a dropdown
  (identity + role + red Log out), which raises a confirmation dialog. See
  Region 1 for the full spec.
- **Export/Import placement** — the two-button row is pinned at the **bottom**
  of the Saved panel, below the list.
- **Markdown "Publish"** — deferred for more thought; captured as a separate
  proposed issue (`ISSUE-publish-as-markdown.md` in this bundle).
- **Saved-query export/import** — JSON, spec'd in "Export / Import saved
  queries" above.

---

## Open questions for the design + product team

(These came up while building the prototype / reviewing the live app and
weren't fully resolved.)

1. **`content`-style blob columns**: text cells holding large values (full HTML
   documents, long JSON) are unreadable inline even with column resize. Add a
   **cell-detail drawer**: click a cell → side panel/modal with the full value,
   pretty-printed, and a **rendered-vs-source toggle** for HTML. Pair with
   `max-width` + ellipsis truncation on text cells. **Highest-impact open item.**
2. **Sticky first column(s)**: freeze `#` (and ideally the first data column)
   during horizontal scroll so row identity isn't lost when reading wide
   columns to the right.
3. **NULL rendering**: render `NULL` distinctly (faint italic "null"), never as
   an empty cell — otherwise NULL is indistinguishable from an empty string,
   which matters on a tool people use to learn unfamiliar data.
4. **Long version string in header**: e.g.
   "ClickHouse 26.3.10.20001.altinityantalya" crowds the top bar and will
   overflow on narrow widths. Truncate (e.g. `26.3.10`) with the full string on
   hover.
5. **Saved-query storage**: `localStorage` today (per-browser, fragile). JSON
   export/import is the interim mitigation; account-backed server sync is the
   roadmap answer (and unlocks real shared-query URLs via the existing Share
   button).
6. **Tab persistence**: should open tabs + their SQL survive a refresh? (Likely
   yes — localStorage.)
7. **Query cancellation**: ClickHouse supports `KILL QUERY`. Surface an inline
   "Cancel" affordance on the running button?
8. **Streaming results**: large result-sets — paginate, or virtual-scroll the
   whole thing? Recommend virtual scroll (TanStack Virtual / react-window).
9. **Errors**: error UI isn't in the prototype. Treat the result pane as the
   surface (red banner + traceback in mono).
10. **Auth**: the original page is auth-gated. Login screen design wasn't in
    scope for this round. Coordinate with whoever owns it.
11. **Accessibility**: contrast in dark mode is good (Inter @ `#E6E6E8` on
    `#0E0E10` ≈ 14:1). Audit segmented control + chart bars in light mode.
    Wire keyboard nav for the schema tree (↑↓ to move, → to expand). The
    shortcuts modal needs a real `role="dialog"` with focus trap.
