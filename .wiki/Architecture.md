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
2. `src/application/query-execution-service.js` (normal/script reads) and
   `src/application/export-service.js` (exports) send their HTTP requests
   through `src/net/authenticated-clickhouse-request.js`'s
   `authenticatedProgress`/`authenticatedText`/`authenticatedResponse`
   entrypoints (#630 Phases 6-7); `src/net/ch-client.js`'s `queryJson` (its
   one remaining schema/catalog/reference caller) goes through that same
   module's `authenticatedJson`. That module owns auth/epoch/retry/
   lifecycle policy (moved out of `ch-client.js`'s former `authedFetch`/
   `transportFor(ctx)`, deleted outright) and builds the
   `@altinity/clickhouse-http` package client directly, composing it with
   the package's response consumers. Query-execution's own Table/KPI/TSV/
   explicit-format mapping and row-cap policy now live in
   `query-execution-service.js` itself (#630 Phase 7, moved off the deleted
   `net/ch-client.js` `runQuery`/`exportQuery`). The narrow transport
   contract (`src/net/clickhouse-transport.types.js` +
   `src/net/clickhouse-http-transport.js`, #585 Phase 1) is deleted
   outright in #630 Phase 7 — `killQueryWithLease`'s frozen-lease bypass
   now calls the package's own stateless `killQuery` directly, and there
   is exactly one generic ClickHouse HTTP transport implementation left in
   the repository.
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
