---
name: SQL Browser
description: A precise, calm, ClickHouse-native workspace for querying, investigation, operations, and dashboards.
colors:
  clickhouse-blue: "#0079AD"
  clickhouse-blue-deep: "#005F8A"
  accent-text-light: "#005F8A"
  accent-text-dark: "#2596CC"
  success-light: "#137A38"
  success-dark: "#4ADE80"
  log-fatal-light: "#B91C1C"
  log-fatal-dark: "#EF4444"
  log-error-light: "#DC2626"
  log-error-dark: "#F87171"
  log-warn-light: "#B45309"
  log-warn-dark: "#FBBF24"
  log-info-light: "#15803D"
  log-info-dark: "#4ADE80"
  log-debug-light: "#1D4ED8"
  log-debug-dark: "#60A5FA"
  log-trace-light: "#64748B"
  log-trace-dark: "#94A3B8"
  kind-view: "#14b8a6"
  kind-mv: "#8b5cf6"
  kind-dictionary: "#3b82f6"
  kind-distributed: "#f97316"
  kind-buffer: "#eab308"
  kind-merge: "#64748b"
  role-pk: "#ff8f6b"
  role-sk: "#6bb6ff"
  role-partition: "#c297ff"
  sql-keyword-dark: "#C586C0"
  sql-keyword-light: "#AF00DB"
  sql-func-dark: "#DCDCAA"
  sql-func-light: "#795E26"
  sql-string-dark: "#CE9178"
  sql-string-light: "#A31515"
  sql-number-dark: "#B5CEA8"
  sql-number-light: "#098658"
  sql-comment-dark: "#6A9955"
  sql-comment-light: "#008000"
  sql-agg: "#E0B341"
  sql-cast: "#4FC1FF"
  light-canvas: "#FAFAFA"
  light-surface: "#FFFFFF"
  light-subtle: "#F5F5F4"
  light-chip: "#EEECE8"
  light-ink: "#1A1A1F"
  light-muted: "#57575E"
  light-faint: "#696971"
  light-border: "#E5E3DE"
  dark-canvas: "#0E0E10"
  dark-surface: "#131316"
  dark-raised: "#1A1A20"
  dark-chip: "#1F1F26"
  dark-ink: "#E6E6E8"
  dark-muted: "#A0A0A8"
  dark-faint: "#8A8A93"
  dark-border: "#1F1F26"
  numeric-light: "#0F766E"
  numeric-dark: "#92E1D8"
  error-light: "#B91C1C"
  error-dark: "#F87171"
  warning-light: "#B45309"
  warning-dark: "#FBBF24"
typography:
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  data:
    fontFamily: "JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  xs: "3px"
  sm: "5px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.clickhouse-blue}"
    textColor: "{colors.light-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "42px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.light-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 9px"
    height: "24px"
  input:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 11px"
    height: "38px"
  chip:
    backgroundColor: "{colors.light-chip}"
    textColor: "{colors.light-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 9px"
  dashboard-tile:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.md}"
    padding: "0"
---

# Design System: SQL Browser

## 1. Overview

**Creative North Star: "The Focused Workbench"**

SQL Browser is a dense professional tool that disappears behind the work. Its visual system uses quiet neutral planes, fine structural borders, compact controls, and one ClickHouse-blue accent to keep attention on SQL, schemas, results, and operational evidence. It should feel as approachable and restrained as Notion while retaining the precision expected by DBAs and analysts.

Complexity is revealed contextually. Stable navigation and inspection controls remain immediately available; configuration appears only when the chosen task requires it. The system explicitly rejects Grafana-style configuration density, IDE-like complexity, decorative dashboards, and generic database chrome that competes with the data.

**Key Characteristics:**
- Restrained neutral surfaces with ClickHouse Blue reserved for action and state.
- Compact, consistent controls built for sustained professional use.
- Sans-serif interface language paired with monospace SQL, values, and technical metadata.
- Structural borders and tonal layers before shadows.
- Responsive behavior that changes the workspace structure, not its typographic identity.

## 2. Colors

The palette pairs ClickHouse Blue with Porcelain light surfaces and Graphite dark surfaces. Semantic colors communicate state; they are never decorative.

### Primary
- **ClickHouse Blue** (`#0079AD`): primary actions, current selections, focus, sort state, and purposeful links.
- **Deep ClickHouse Blue** (`#005F8A`): pressed or strengthened accent treatment; never a second competing accent. It is also `--accent-text` in light theme — text-grade accent *is* a strengthened accent treatment, so this needs no new hue.
- **Lifted ClickHouse Blue** (`#2596CC`): `--accent-text` in dark theme only. The one genuinely new value, because accent-coloured text on a dark surface has to get *lighter* and the palette had nothing above `#0079AD`.

### Neutral
- **Porcelain Canvas** (`#FAFAFA`) and **Porcelain Surface** (`#FFFFFF`): light-mode workspace and foreground planes.
- **Warm-Gray Subtle** (`#F5F5F4`) and **Stone Chip** (`#EEECE8`): toolbars, table headers, inactive controls, and grouping surfaces.
- **Light Ink** (`#1A1A1F`), **Light Muted** (`#57575E`), and **Light Faint** (`#696971`): primary, supporting, and tertiary light-mode text.
- **Graphite Canvas** (`#0E0E10`), **Graphite Surface** (`#131316`), and **Graphite Raised** (`#1A1A20`): dark-mode workspace, chrome, inputs, and overlays.
- **Dark Ink** (`#E6E6E8`), **Dark Muted** (`#A0A0A8`), and **Dark Faint** (`#8A8A93`): primary, supporting, and tertiary dark-mode text.
- **Light Border** (`#E5E3DE`) and **Dark Border** (`#1F1F26`): structural separation without card-like decoration.

### Tertiary
- **Numeric Teal** (`#0F766E` light / `#92E1D8` dark): numeric table values, separating data from labels without relying on weight.
- **Error Red** (`#B91C1C` light / `#F87171` dark): failures and destructive outcomes.
- **Warning Amber** (`#B45309` light / `#FBBF24` dark): degraded, incomplete, or cautionary states.

### Named Rules

**The One Accent Rule.** ClickHouse Blue is the only general-purpose accent and occupies no more surface than the active task requires.

**The Evidence Rule.** Error, warning, log-level, and numeric colors encode meaning. Never use them as decoration, and never rely on color alone.

### Sub-palettes

Three palettes sit alongside the UI system. Each is separate because it encodes
something the UI palette cannot, and each is a **token family**, not scattered hex.

**Semantic state** — `--error-fg`, `--warn-fg`, `--success-fg`, with matching `-bg`/`-bd`
tints. `--success-fg` and the danger colour used to be referenced as
`var(--success, #238636)` / `var(--danger, #cf222e)` against tokens that were **never
defined**, so KPI deltas and export status silently ignored the theme and failed AA
(`#238636` is 3.92:1). They are real tokens now.

**Log levels** — `--log-fatal` / `-error` / `-warn` / `-info` / `-debug` / `-trace`.
A six-step severity ramp for the logs panel, always paired with the level's own text.

**Object kinds** (`--kind-*`) and **key roles** (`--role-*`) — the categorical palette
naming ClickHouse object kinds in the EXPLAIN pipeline graph and schema graph: view,
materialized view, dictionary, distributed, buffer, merge. The same hue must mean the
same kind in the node fill, the edge, and the legend swatch, which is exactly why they
are tokens: they were previously three separate copies of a hex that could drift apart.
Held identical across themes — what kind a node is does not depend on the theme.

**SQL syntax** (`--sql-*`) — the code-editor theme, deliberately following editor
convention rather than the ClickHouse-blue system, because a developer reads a keyword
colour faster than they read a brand. Light and dark values differ; the five
`[data-theme='light'] .sql-*` override rules that used to duplicate them are gone.

### Named Rules

**The Measured Contrast Rule.** Every foreground token must reach 4.5:1 against every
background token it can land on, in both themes — asserted by
`tests/unit/typography-contract.test.js`, not by eye. The tertiary tier is the one that
gets this wrong by default: `--fg-faint` shipped for a long time at 2.55–3.66:1 while
carrying most of the smallest text in the product (row counts, capped/cancelled badges,
tile footers). It now clears AA on its worst background in both themes, at the cost of a
smaller tonal step below `--fg-mute` — separation in that tier comes from size and
placement as much as tone.

## 3. Typography

**Display Font:** Inter, self-hosted and inlined into the artifact  
**Body Font:** Inter, self-hosted and inlined into the artifact  
**Label/Mono Font:** JetBrains Mono, self-hosted and inlined into the artifact

**Delivery.** Both faces are **bundled into `dist/sql.html`** as `@font-face` rules with
base64 `data:` sources (`build/fonts.mjs`), latin subset, upright only, variable weight
axis — about 89 KB of woff2 for the pair. Before this they were named in the stacks but
never delivered: with no `@font-face` and no CDN (hard rule 4 forbids third-party
requests), they rendered only for users who happened to have them installed locally, and
everyone else silently got the platform UI face and Menlo/Consolas. The design system
described type most users never saw.

The fallback stacks stay in `--ui` / `--mono` and still matter: the subsets carry latin
only, and `unicode-range` deliberately lets any codepoint outside it — Cyrillic or CJK
result cells, and the ⌘/↵/→ glyphs — fall through to the platform font rather than
render tofu. Italics are not shipped; the browser synthesizes an oblique for the eight
secondary uses (schema comments, stale-value hints, Markdown `<em>`), which is the right
trade against doubling the font payload.

**Character:** One restrained sans-serif family keeps the product familiar and calm.
Monospace marks SQL, values, shortcuts, identifiers, timings, and technical metadata as
evidence rather than interface prose.

### Hierarchy

Sizes are **tokens, not literals** — `--text-*` in `src/styles.css`, enforced by
`tests/unit/typography-contract.test.js`. Weight and line height are tokenized the same
way (`--fw-*`, `--lh-*`). Nothing in the stylesheet may set a literal size.

**Interface ramp** — six steps, used for everything the user operates:

| Token | Size | Weight | Role |
|---|---|---|---|
| `--text-nano` | `9px` | — | SVG graph labels only (see the exception below) |
| `--text-micro` | `10.5px` | 500–600 | micro-metadata, eyebrow labels, key caps, state badges |
| `--text-label` | `11.5px` | 400–500, 1.3 | compact controls, tabs, table headers, **and** mono data — SQL, cell values, identifiers, timings, counts |
| `--text-body` | `12.5px` | 400–600, 1.25–1.5 | primary labels, tree rows, button text, descriptions, Markdown body, messages, **and the Dashboard surface title at 600**; prose stays within 65–75 characters where layout permits |
| `--text-headline` | `14px` | 600, 1.25 | dialog, drawer and tile titles |
| `--text-title` | `16px` | 700, 1.25 | full-plane headings that own their own vertical space — every "this does not exist" state, and the empty-workspace and empty-Dashboard prompts |

**Document ramp** — `--text-doc-h3` `15px`, `--text-doc-h2` `17px`, `--text-doc-h1` `20px`.
Read surfaces only (reference docs, Markdown panels, the login heading), where the content
is prose the user reads rather than chrome they operate. Its adjacency to the interface
ramp is not a hierarchy: the two never appear in the same block.

**Display** — `--text-mark` `22px` (the login lockup glyph) and `--text-metric`
`clamp(24px, 4vw, 38px)` / `--text-metric-tile` `clamp(16px, 14cqi, 38px)` (the KPI value,
which also takes `tabular-nums` so a refreshing metric does not twitch).

### Named Rules

**The Evidence Typeface Rule.** Use monospace only for content the user reads as code,
data, identity, or measurement. Interface actions remain sans-serif. Note that label and
data share one step (`--text-label`): the difference between them is `--ui` versus
`--mono`, never size.

**The Compact Scale Rule.** Product hierarchy comes from weight, placement, and surface
structure. Never introduce oversized display typography into the application shell —
nothing outside the document and display sets may exceed `--text-title`.

A title *inside a row of controls* steps up by weight, not by size: the Dashboard surface
toolbar names the open document at `--text-body`/`--fw-semibold`, one weight above the
`--text-label` controls flanking it, in a 40px row. It reached for a size step instead and
landed on `13px` — half a pixel above `--text-body`, a step nobody could see and one the
One-Pixel Floor forbids. A toolbar is not a heading's own space; `--text-headline` and
`--text-title` belong to surfaces that give a title a line of its own.

**The Zoomable-Surface Exception.** `--text-nano` (`9px`) is admissible only as SVG text
inside the EXPLAIN pipeline graph and schema graph. Those surfaces pan and zoom, so their
labels are not read at a fixed size the way DOM chrome is, and the layout that positions
them (`core/dot-layout.js`) is measured against this size. It must never be used for DOM
text; the floor for anything the user reads without zooming is `--text-micro`.

**The One-Pixel Floor.** No two steps within a ramp may sit closer than 1px. At this
product's sizes a 0.5px step buys about 0.26px of x-height — below one device pixel at 1×,
and smaller than the variation between platform fallback faces. It cannot carry hierarchy;
it only records that nobody decided. The ramp these tokens replaced had grown to 22 values
with 9/9.5, 10/10.5 and 13.5/14/14.5 all coexisting, five of them under the documented
floor, because there was no token to drift *from*.

**The Authored-Surface Rule.** Every text-bearing element must be sized by this
stylesheet. The user-agent sheet sizes `h1`–`h6` as `em` multiples of the inherited size
and gives bare `<button>`s their own family, so a surface with no CSS does not fall back
to something plain — it falls back to *browser chrome*. That is how a 32px `h1`, a 19.5px
`h2`, and a 13.333px Arial confirmation dialog reached production. `body` therefore
carries an explicit base size, `h1`–`h6` reset to `inherit`, and the contract test fails
on any class group the stylesheet does not match.

**The Text-Grade Accent Rule.** ClickHouse Blue as *text* is `--accent-text`, not
`--accent`: `#0079AD` measures 4.10:1 on light chips and 3.83:1 on dark surfaces, both
below AA. Fills, borders, focus rings, carets and icons keep `--accent`, where 1.4.11's
3:1 applies and it passes.

### Corner Radii

Four steps plus a pill, chosen by what **kind** of surface a box is rather than by its
size — `--r-xs` marks and glyph slots, `--r-sm` controls, `--r-md` containers, `--r-lg`
large overlays, `--r-pill` capsules. The stylesheet had drifted to fourteen values
(2/3/4/5/6/7/8/9/10/11/12/16/18/20px) against a documented four-step scale, with 4/5/6/7
all in play for the same kind of control. Fourteen radii state nothing.

## 4. Elevation

The system is flat and structurally layered. Background shifts and one-pixel borders define the persistent shell, panels, tables, and dashboard tiles. Shadows are reserved for temporary surfaces that physically overlap the workspace: menus, popovers, dialogs, detached overlays, and side drawers.

### Shadow Vocabulary

One token per entry. The stylesheet had drifted to fourteen distinct shadows across
eleven black alphas, so two popovers could differ for no reason — the vocabulary had
stopped communicating placement, which is its only job.

- **`--shadow-lift`** (`0 1px 2px rgba(0,0,0,.15)`): selected segmented controls only.
- **`--shadow-float`** (`0 6px 18px rgba(0,0,0,.3)`): toasts, export progress, a tile
  being dragged — transient, close to the surface.
- **`--shadow-popover`** (`0 8px 28px rgba(0,0,0,.4)`): menus and compact floating choices.
- **`--shadow-dialog`** (`0 20px 60px rgba(0,0,0,.45)`): blocking overlays.
- **`--shadow-drawer`** (`-8px 0 28px rgba(0,0,0,.35)`): the side drawers.
- **`--scrim`**: the modal/drawer backdrop.

Rings are their own family — `--ring`, `--ring-warn`, `--ring-error` — a 3px translucent
halo in the state's own hue, so the ring says which *kind* of state has focus rather than
only that something does. That claim only holds while the **hue is the only thing that
varies**, so the halo is one `color-mix(in oklab, … 22%, transparent)` across the family,
asserted rather than reviewed.

- **`--ring-nav`**: the fourth member, and the one that is not about focus. It marks the
  tile or filter a navigation request *sent you to* — something you must find without
  having pointed at anything — so it adds a solid `--accent` edge under the same halo at
  a wider spread. It sets **no radius of its own**: a `box-shadow` already follows the
  radius of whatever it marks, and a highlight that re-rounds its target makes the element
  change shape at the moment it asks to be looked at.

### Named Rules

**The Flat-by-Default Rule.** Persistent surfaces never receive decorative drop shadows. If a surface does not overlap another surface, use tone and borders instead.

**The Structural Elevation Rule.** Shadow direction and strength must explain physical placement: downward for popovers, broad for modal depth, lateral for drawers.

## 5. Components

### Buttons
- **Shape:** compact, gently curved edges — `--r-sm` (`5px`) for controls, `--r-md`
  (`8px`) for the login primary. Sized to their context rather than forced into pills.
- **Primary:** ClickHouse Blue with white text; the login primary is `42px` high with `16px` horizontal padding.
- **Hover / Focus:** slight brightness or neutral hover fill; keyboard focus uses the accent border and a three-pixel low-opacity accent ring.
- **Quiet / Ghost:** transparent at rest, muted text, optional one-pixel border; hover reveals a neutral background and stronger text.
- **Disabled:** reduced opacity with the action cursor removed; loading communicates ongoing work without changing the button vocabulary.

### Chips
- **Style:** compact tonal grouping using the chip surface, muted text, `--r-sm`, and
  minimal padding. A *capsule* uses `--r-pill`, never a px radius: `border-radius: 18px`
  silently stops being a capsule the moment the box grows past 36px tall.
- **State:** selection uses the content surface, stronger text, or ClickHouse Blue; semantic chips use their assigned state color and accompanying text/icon.

### Cards / Containers
- **Corner Style:** `--r-md` (`8px`) for dashboard tiles, popovers and grouped controls;
  `--r-lg` (`12px`) for dialogs and the login card.
- **Background:** foreground surface token for the active theme.
- **Shadow Strategy:** none for persistent tiles; follow the elevation vocabulary for overlays.
- **Border:** one-pixel structural border using the theme border token.
- **Internal Padding:** compact and purpose-specific (`8–20px`); data regions usually extend to edges under a distinct header.

### Inputs / Fields
- **Style:** surface background, one-pixel border, `--r-sm`, `--text-label`/`--text-body` text, and compact vertical sizing.
- **Focus:** ClickHouse Blue border plus a `3px` translucent focus ring on form fields; editor focus remains integrated with the workspace.
- **Error / Disabled:** semantic text/background/border tokens for errors; opacity and cursor changes for disabled controls.

### Navigation
- Table, JSON, panel types, query tabs, schema/library modes, and dashboard layout choices share one quiet tab/segmented-control vocabulary. Inactive items use muted text on transparent or subtle surfaces; active items gain ink, a tonal surface, a structural border, or the accent. Mobile replaces the split workspace with a bottom navigation for Tables, Editor, and Results at `768px` and below; on the Dashboard surface that bar keeps only **Editor**, as the route back to the Workbench.
- The Dashboard surface toolbar (`[layout · tile count · search · filters] … [freshness] · [View | Edit]`) is the **same** toolbar as the filter row stacked beneath it — one gap, one height, one padding — so the two read as one sticky top bar rather than two competing bands.
- Leaving a Dashboard is a **per-tile** act, not a global one: each query-backed tile carries a quiet `Open in Workbench` icon in its own chrome, subtle until the tile is hovered or the icon focused, always shown where there is no hover. There is no Dashboard-level back button — an action that names its document beats generic back-navigation holding primary toolbar space.

### Data Table
- Sticky headers and row numbers preserve context during two-axis scrolling.
- JetBrains Mono at `--text-label` (`11.5px`) makes values align and scan reliably.
- Rows are separated by faint borders; hover uses a neutral tint, not a card treatment.
- Numeric values use Numeric Teal and right alignment. Long text truncates and opens in the detail drawer.
- Column resizing and sorting expose direct manipulation without permanent configuration UI.

### SQL Editor
- CodeMirror occupies a flat editor plane using the monospace stack and `22px` line height.
- The caret and meaningful selection/search states use ClickHouse Blue.
- Completion and hover surfaces use the same overlay elevation, neutral palette, and compact density as the rest of the application.

### Dashboard Tiles
- Tiles use `--r-md`, a one-pixel border, and no shadow. (They shipped at 10px for a
  while, against this very line.)
- Header, body, and footer are structurally distinct; the visualization receives the largest uninterrupted area.
- Arrange and Report layouts change topology without changing component styling.

## 6. Do's and Don'ts

### Do:
- **Do** keep ClickHouse Blue scarce and meaningful: action, selection, focus, and links — `--accent` for fills, borders, rings and icons, `--accent-text` wherever it colors text.
- **Do** use `1px` borders and tonal surface changes to organize persistent workspace regions.
- **Do** keep controls compact, consistent, and close to the content they affect.
- **Do** use progressive disclosure for configuration and advanced ClickHouse features.
- **Do** pair every semantic color with text, iconography, position, or another non-color signal.
- **Do** preserve keyboard access, visible focus, responsive structure, and reduced-motion behavior to the WCAG 2.2 AA baseline.

### Don't:
- **Don't** introduce Grafana-style configuration density or permanent option panels for contextual settings.
- **Don't** reproduce IDE-like complexity, competing toolbars, or generic database features that dilute ClickHouse focus.
- **Don't** build decorative dashboards; every color, tile, metric, and visualization must serve investigation or monitoring.
- **Don't** add generic database chrome that competes with SQL, schemas, results, or operational evidence.
- **Don't** use persistent card shadows, glass effects, gradient text, oversized radii, or ornamental motion.
- **Don't** replace familiar controls with novel affordances merely to make the interface distinctive.
