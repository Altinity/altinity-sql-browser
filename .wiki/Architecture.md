# Architecture

Back to [[Home]]. Related: [[Source-Map]], [[Decisions-and-Roadmap]].

## Dependency shape

```text
main.js (bootstrap + concrete adapters)
  ├─ ui/ (renderers and controller)
  ├─ editor/ (injected SQL + Spec CodeMirror adapters)
  ├─ net/ (OAuth and ClickHouse HTTP)
  ├─ state.js (signals-backed model and operations)
  └─ core/ (pure parsing, transforms, layout, formatting)

ui/ → net/state/core     net/ → core     core/ → nothing
```

`src/main.js` bootstraps the app; `createApp(env)` in `src/ui/app.js` is the
composition root, receiving browser and service dependencies and returning the
`app` controller every render module addresses. Render modules must not import
`app.js`, which prevents cycles. `createApp` builds `app` via one typed object
literal with no `as App` cast — a member missing from construction is a `tsc`
error, not a runtime hole (#588). Four responsibilities that used to live
entirely inside `createApp` are now their own modules the composition root
wires up: workspace persistence/cross-tab sync
(`src/application/workspace-session.js`), `/sql` routing and main-surface
navigation (`src/application/surface-navigation.js`), the Workbench variable
strip (`src/ui/workbench/variable-strip.js`), and the save/conflict cluster
(`src/ui/workbench/save-controller.js`) — `src/application/*` may never import
`src/ui/`, mechanically enforced by `build/check-boundaries.mjs`. The
Dashboard's own render module (`src/ui/dashboard.js`, `renderDashboard`)
follows the same pattern at a smaller scale: its repaint-decision logic is the
pure `src/dashboard/application/dashboard-repaint-plan.js`, and its pointer-
gesture handling (corner-drag resize, Command/Ctrl-drag reorder, modifier cue)
is `src/ui/dashboard-tile-gestures.js`'s `createTileGestureController`, built
fresh per render behind an injected `TileGestureDeps` seam (#589).

## Side-effect seams

- Network functions receive `fetch` or a ClickHouse context.
- PKCE, storage, time, location, and browser globals are parameters.
- CodeMirror is behind explicit injected `app.sqlEditor` and `app.specEditor`
  seams; only the composition root chooses the adapters. SQL actions always
  address the SQL adapter rather than the currently visible document.
- Chart.js and Dagre are concrete adapters injected as `app.Chart` / `app.Dagre`.
- Signals coordinate state. Imperative/high-frequency surfaces remain adapters.

This pattern keeps tests genuine: plain stubs replace dependencies without broad
module mocking.

## Query path

1. The editor/controller prepares SQL and typed parameters.
2. `src/net/ch-client.js` sends the HTTP request with injected auth/fetch context,
   delegating generic request construction and stream mechanics through a narrow
   transport contract (`src/net/clickhouse-transport.types.js` +
   `src/net/clickhouse-http-transport.js`, #585 Phase 1). Since #630 Phase 6,
   auth/epoch/retry/lifecycle policy itself lives in
   `src/net/authenticated-clickhouse-request.js` (moved out of `ch-client.js`'s
   former `authedFetch`/`transportFor(ctx)`, deleted outright), which builds the
   `@altinity/clickhouse-http` package client directly and composes it with the
   package's response consumers; `ch-client.js`'s exported `queryJson`/
   `runQuery`/`exportQuery` reach it as callers, keeping their own product-level
   result/error handling.
3. `JSONStringsEachRowWithProgress` is folded line by line by pure stream logic.
4. Results resolve through the panel registry to table, chart, logs, KPI, filter,
   text, or graph-oriented renderers.
5. One auth refresh is attempted for expired/denied tokens.

## Build shape

`build/build.mjs` bundles `src/main.js` with esbuild, minifies it, and inlines JS
and `src/styles.css` into `build/template.html`. Output is `dist/sql.html`, with
no third-party runtime requests.

Canonical source: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
[`CLAUDE.md`](../CLAUDE.md).
