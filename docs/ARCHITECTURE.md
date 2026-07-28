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
workspace/     pure stored-workspace aggregate, persistence contracts, and mutations
dashboard/     Dashboard model/layouts/application runtime (model/layouts <- application <- UI)
ui/workbench/  the workbench route: session (run lifecycle) + shell (DOM + effects)
ui/dashboard.ts the dashboard route shell (DOM + effects)
ui/*           render modules (hyperscript), editor ports live in editor/
ui/app.ts      composition/bootstrap: constructs everything, wires routes
state.ts       the shared signal-backed model + pure ops
main.ts        page bootstrap: OAuth callback, share links, route dispatch
```

Dependency direction is strictly downward. Enforced mechanically by
`build/check-boundaries.mjs` (runs in `pretest` as `check:arch`):

- `src/application/**` never imports `src/ui/**` or `src/editor/**`; the
  Dashboard and workspace layers cannot import higher layers, and Dashboard
  application depends only on Dashboard model/layouts (type-only imports count).
- `src/ui/workbench/**` and `src/ui/dashboard/**` never import each other,
  never import the editor (dashboard), and never import `src/ui/app.ts` —
  shells receive everything injected.

Two known, deliberate exceptions predate #276 and are out of its scope:
`core/saved-io.ts` imports a type from `editor/spec-editor.types.js`, and
`editor/codemirror-adapter.ts` imports `ui/dom.js` + `ui/dnd-mime.ts`.

## The services (`src/application/`)

Services and sessions take narrow dependency bags — never the `App` object or
the full `AppState` (narrow `Pick`-shaped state slices are structurally
satisfied by `AppState`). The pure projections and state transitions in this
layer take their explicit inputs directly. Side effects are always injected
(fetch via the ClickHouse `ctx`, clocks, `uid`, storage, timers), so every
module is tested with plain stubs at the per-file coverage gate.

| Module | Owns |
|---|---|
| `authenticated-execution-scope` (`app.executionScope`) | one disposable, epoch-fenced registry for authenticated operation owners; closes local work synchronously and performs best-effort remote cancellation from an immutable credential lease |
| `query-execution-service` (`app.exec`) | the shared request/stream/normalize read core + the script transport loop (retry classification, stop-on-first-failure, per-attempt `query_id`); stateless `kill(queryId)` — cancellation is caller-owned (`AbortController`s live with the owning session) |
| `connection-session` (`app.conn`) | authoritative auth + connection lifecycle (`starting` / `connected` / `refreshing` / `offline` / `auth-required` / `reauthenticating` / `signed-out`), OAuth PKCE login/refresh, Basic probing, IdP config, identity, token storage, sign-out, and **the single live `chCtx` object** (mutated in place — `authConfirmed` by `net/ch-client`, `origin` by sign-in — never reconstructed) |
| `schema-catalog-service` (`app.catalog`) | server version, schema tree, lazy columns, SQL reference/completions, entity-doc cache; catalog/schema/reference/docs transports share a connection-generation abort signal, and `invalidate()` synchronously aborts them while generation fences reject stale writes |
| `workbench-parameter-session` (`app.params`) | `{name:Type}` analysis/prepare/gate policy, input-vs-execute hardening, enum inference, recent values; reads the live shared `AppState` slices through accessors |
| `export-service` (`app.exports`) | direct + script export behind an injectable `ExportSink` (`pickFile`/`pickDirectory`); hold-back exception inspection, `.partial` semantics, its own cancellation state |
| `query-document-session` (`app.queryDoc`) | Spec evaluation/diagnostics/dirty flags over `QueryTab`s, editor-mode policy |
| `saved-query-service` (`app.saved`) | create/commit saved queries (validate-before-persist), history recording, share-URL building — typed results; the shell renders messages |
| `schema-graph-session` (`app.graph`) | lineage load/expand/node-detail lifecycle with stale-request guards; abort state is session-private |
| `app-preferences` (`app.prefs`) | typed preference persistence (`save(name, value)` + `toggleTheme()`) |
| `ch-session-params` | pure helpers minting/attaching the per-tab ClickHouse HTTP `session_id` (TEMPORARY/SET stickiness), shared by the workbench hooks and export wiring |
| `dashboard-create` / `dashboard-delete` / `dashboard-title` | serialized workspace mutations for Dashboard creation, deletion, and title edits |
| `dashboard-panel-metadata` | serialized workspace mutations for Dashboard tile title/description overrides |
| `dashboard-tree-model` | pure Dashboard-tree projection, including inferred Variables and navigation rows |
| `dashboard-variable-config` | serialized commits for Dashboard Variable option-SQL configuration |
| `library-assignment-service` | serialized Library-to-Dashboard panel and Variable assignments, plus user-facing assignment outcomes |
| `main-surface` | pure Query/Dashboard surface state, routing, history restoration, and focus transitions |

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
- `dashboard/application/dashboard-viewer-session.ts` owns the Dashboard
  runtime: the 6-way tile pool, wave generations (reserved at wave creation),
  per-tile cancellation, Variable commits, and `destroy()`. Its input is a
  stored `DashboardDocumentV2` plus workspace queries and narrow injected
  interfaces. `ui/dashboard.ts` is its shell (own header; no sidebar), typed
  against a narrow `DashboardApp`, not `App`.

Lifecycle ownership: **cancellation state always lives with the session that
owns the operation** (issue #276 rule 5) — never in the transport service.
While authentication is valid, those owners register with the current
`AuthenticatedExecutionScope`. An involuntary auth-loss transition closes that
scope exactly once: owner aborts happen synchronously, old registrations become
observationally stale, and query ids captured before each abort are cancelled
best-effort through a frozen lease containing the exact origin and complete
`Authorization` header. That cancellation path has no token refresh, retry, or
auth-loss callback.

The application shell and document session are deliberately outside the
execution scope. Auth loss therefore preserves the mounted editor, tabs,
drafts, dirty flags, navigation, and completed results while inline login
controls replace authenticated actions. In-place Basic login creates a fresh
scope for the new credential epoch and reloads connection-scoped metadata
without rebuilding the shell. Its inline form is reusable: a successful
recovery resets submission state, clears the password, and hides password
visibility, so a later loss can be recovered the same way.

OAuth reauthentication must reload the page, so it crosses that boundary with
a separate, versioned `sessionStorage` checkpoint. The checkpoint is written
only for save-relevant dirty work and is bound to both the generated OAuth
state and the current workspace id/key. It contains authored document state
only: tab order and identity, query or Dashboard-variable bindings, SQL and raw
Spec drafts, editor mode, dirty flags, and saved-query reconciliation metadata.
It never contains credentials, results, ClickHouse session ids, result-column
metadata, or running/export state. A retained checkpoint is rebound to a new
OAuth state on retry without replacing its drafts. Retry authority is kept
separately in a tab-scoped, TTL-bound validated-callback marker containing the
callback state, validation time, and a compact fingerprint of the authored
document session at validation. The fingerprint fences automatic publication;
it is a change detector, not authorization material, and a checkpoint alone
never authorizes an automatic restore. Starting a new OAuth attempt invalidates
an older marker. Version-1 markers lack the fingerprint, so they are not
migrated: they are unsupported and cleared, while a retained checkpoint can be
rebound by a later OAuth retry that writes a version-2 marker.

After a successful callback, bootstrap restores the return route and loads the
committed workspace normally. It then applies a matching checkpoint, reconciles
linked tabs, and revalidates every raw Spec draft before the first signed-in
render; invalid in-progress Spec text remains byte-for-byte authored while its
diagnostics are rebuilt. Workspace-unavailable and prepublication storage or
validator failures retain the recovery unpublished. A valid pending recovery
suppresses legacy shared content and retries after an authoritative workspace
load only while the document session still has the marker's fingerprint. If it
changed, automatic publication stops and the shell offers an explicit
**Restore drafts** action; automatic recovery never replaces newer work in RAM.
Workspace-mismatched checkpoints and their callback markers are retained for a
later matching workspace rather than cleared. Its validated-callback marker is
retired before publication. The ordinary dirty unload guard is restored before
the checkpoint is consumed. Malformed, unsupported, or logically expired after
15 minutes checkpoints are ineligible and cleared best-effort while normal
bootstrap continues; an OAuth-state mismatch is not consumed, so an older
callback cannot apply or destroy a newer retry. TTL expiry controls restore
eligibility and does not promise eager physical deletion from browser storage.
The one-shot unload bypass is armed only after a durable checkpoint write; a
write failure leaves navigation and the normal dirty guard untouched.

Explicit Log out remains the separate destructive policy: it closes the scope,
tears down the workbench and Dashboard, clears credentials and any pending
OAuth document checkpoint and validated-callback marker, and renders the
signed-out login surface.

Connection lifecycle ownership follows the same rule. `ConnectionSession`
publishes one read-only signal and assigns a monotonically increasing
credential epoch whenever credentials are installed or invalidated. Refresh is
single-flight within an epoch; a late refresh or transport response cannot
write tokens, report auth loss, or repaint the replacement epoch. The network
boundary rechecks that epoch after every credential await and immediately
before each fetch attempt, so old work cannot execute under a replacement
session's credentials. This includes async HTTP error-body classification and
IdP config discovery: refresh authority snapshots its epoch, then rechecks it
after discovery and before token-endpoint I/O. A stale discovery therefore
cannot rewrite the replacement epoch's auth-header policy.
`net/ch-client` reports only successful 2xx transport settlement as connected
and rejected, non-aborted `fetch` as offline. HTTP query failures — including a
post-confirmation 401/403 — remain query outcomes, not connection state. The
header chip is a pure projection of this lifecycle; `serverVersion` remains
display metadata and is never connection authority.

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
take a `ctx = {fetch, origin, getToken, refresh, authHeader,
onSignedOut(detail?, expectedEpoch?), currentEpoch?, onTransportConnected?,
onTransportOffline?}`,
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
