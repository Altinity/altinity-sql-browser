# Architecture

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework; state reactivity is `@preact/signals-core`
(ADR-0001), strict TypeScript throughout (ADR-0002). This document reflects
the post-#276 shape: a **modular monolith** — explicit application services and
route-scoped sessions behind a small composition root.

## Layers

```
core/          pure logic (no DOM, no globals, no imports from other layers)
net/           integration: OAuth + the ClickHouse HTTP client (fetch injected via ctx)
application/   route-agnostic services & sessions (no App, no DOM, no ui/editor imports)
ui/workbench/  the workbench route: session (run lifecycle) + shell (DOM + effects)
ui/dashboard/  the dashboard route: session (tile/filter runtime); ui/dashboard.ts is its shell
ui/*           render modules (hyperscript), editor ports live in editor/
ui/app.ts      composition/bootstrap: constructs everything, wires routes
state.ts       the shared signal-backed model + pure ops
main.ts        page bootstrap: OAuth callback, share links, route dispatch
```

Dependency direction is strictly downward. Enforced mechanically by
`build/check-boundaries.mjs` (runs in `pretest` as `check:arch`):

- `src/application/**` never imports `src/ui/**` or `src/editor/**` (type-only
  imports count).
- `src/ui/workbench/**` and `src/ui/dashboard/**` never import each other,
  never import the editor (dashboard), and never import `src/ui/app.ts` —
  shells receive everything injected.

Two known, deliberate exceptions predate #276 and are out of its scope:
`core/saved-io.ts` imports a type from `editor/spec-editor.types.js`, and
`editor/codemirror-adapter.ts` imports `ui/dom.js` + `ui/dnd-mime.ts`.

## The services (`src/application/`)

Each is a `create*(deps)` factory taking a narrow dependency bag — never the
`App` object or the full `AppState` (narrow `Pick`-shaped state slices are
structurally satisfied by `AppState`). Side effects are always injected
(fetch via the ClickHouse `ctx`, clocks, `uid`, storage, timers), so every
service is tested with plain stubs at the per-file coverage gate.

| Module | Owns |
|---|---|
| `query-execution-service` (`app.exec`) | the shared request/stream/normalize read core + the script transport loop (retry classification, stop-on-first-failure, per-attempt `query_id`); stateless `kill(queryId)` — cancellation is caller-owned (`AbortController`s live with the owning session) |
| `connection-session` (`app.conn`) | auth + connection lifecycle: OAuth PKCE login/refresh, Basic probing, IdP config, identity, token storage, sign-out, and **the single live `chCtx` object** (mutated in place — `authConfirmed` by `net/ch-client`, `origin` by sign-in — never reconstructed) |
| `schema-catalog-service` (`app.catalog`) | server version, schema tree, lazy columns, SQL reference/completions, entity-doc cache, `invalidate()` |
| `workbench-parameter-session` (`app.params`) | `{name:Type}` analysis/prepare/gate policy, input-vs-execute hardening, enum inference, recent values; reads the live shared `AppState` slices through accessors |
| `export-service` (`app.exports`) | direct + script export behind an injectable `ExportSink` (`pickFile`/`pickDirectory`); hold-back exception inspection, `.partial` semantics, its own cancellation state |
| `query-document-session` (`app.queryDoc`) | Spec evaluation/diagnostics/dirty flags over `QueryTab`s, editor-mode policy |
| `saved-query-service` (`app.saved`) | create/commit saved queries (validate-before-persist), history recording, share-URL building — typed results; the shell renders messages |
| `schema-graph-session` (`app.graph`) | lineage load/expand/node-detail lifecycle with stale-request guards; abort state is session-private |
| `app-preferences` (`app.prefs`) | typed preference persistence (`save(name, value)` + `toggleTheme()`) |
| `ch-session-params` | pure helpers minting/attaching the per-tab ClickHouse HTTP `session_id` (TEMPORARY/SET stickiness), shared by the workbench hooks and export wiring |

## Route sessions and shells

- `ui/workbench/workbench-session.ts` (`app.workbench`) owns the running
  operation: `run`/`runScript`/`runEntry`/`cancel`, the private run
  bookkeeping (`runT0`/`runQueryId`/ticker) and the in-flight
  `AbortController`. It is the **sole production writer of the `running`
  signal**. DOM stays out via injected hooks; the three run-coupled reactive
  effects register through `attachShell(...)` with captured disposers
  (idempotent on re-render).
- `ui/workbench/workbench-shell.ts` (`mountWorkbenchShell(deps)`) builds the
  workbench DOM (header, sidebar, splitters, tabs, toolbar, var strip,
  results) and registers every other effect. `ui/app.ts`'s `renderApp` is a
  thin call into it.
- `ui/dashboard/dashboard-session.ts` owns the dashboard runtime: the 6-way
  tile pool, wave generations (reserved at wave creation), per-slot
  cancellation, filter waves and merging, `destroy()`. Its input is an
  explicit `DashboardRuntimeInput` built by the shell from the favorites
  list — a stored dashboard document can replace that source without touching
  the session. `ui/dashboard.ts` is its shell (own header; no sidebar), typed
  against a narrow `DashboardApp`, not `App`.

Lifecycle ownership: **cancellation state always lives with the session that
owns the operation** (issue #276 rule 5) — never in the transport service.
`destroy()`/`invalidate()` are wired where a session really ends today:
`signOut` tears down the workbench session, cancels graph/export work, and
invalidates the catalog before the login screen renders. There is no
route-remount mechanism — the dashboard is its own browser tab whose closure
JS never observes — so no teardown theater beyond that.

## The `App` object

`createApp(env)` still returns one `app` object, but it is now a composition
surface, not a controller: the session/service members above, the shared
`state`, the live `dom` region dictionary (reset wholesale per mount), the
injected env seams (Chart, Dagre, editor ports, pickers, clocks), the
`actions` registry (the DOM↔session event boundary render modules call
through), and a handful of genuinely shell-owned composites (`showLogin`,
`signOut`, `toggleTheme`, `openDashboard`, `renderApp`/`renderDashboard`).
Render modules keep taking `app` as a parameter and import nothing from
`app.ts`; most declare their own narrow `Pick`-shaped interfaces
(`LoginApp`, `ShortcutsApp`, `ResultsApp`, `DashboardApp`, …). One deliberate
delegate survives with a documented reason: `app.saveVarRecent` (a mutable
test seam the parameter session reads live).

## Injected-seam pattern

Unchanged from the beginning and now applied uniformly: every side effect is
passed in, never imported — `createApp(env)` injects
`document/window/location/fetch/crypto/sessionStorage`, `ch-client` functions
take a `ctx = {fetch, origin, getToken, refresh, authHeader, onSignedOut}`,
and every `create*Service(deps)` receives its transport/clock/uid/storage
explicitly. The suite needs no network/DOM mocking libraries — plain stubs
suffice, and coverage is genuine.

## Query execution

`runQuery` in `net/ch-client.ts` streams `JSONStringsEachRowWithProgress`,
folded via the pure `applyStreamLine`; a single automatic token refresh on
401/403/`token_verification_exception` (before `authConfirmed` flips, an auth
failure signs out; after, it is a query error).

## Build

`build/build.mjs` runs esbuild (bundle + minify, IIFE), inlines the script and
`styles.css` into `build/template.html` → a single `dist/sql.html`. Seven
bundled runtime dependencies (CodeMirror 6, Chart.js +
chartjs-adapter-date-fns + date-fns, dagre, `@preact/signals-core`, marked);
none is loaded from a third-party CDN.
