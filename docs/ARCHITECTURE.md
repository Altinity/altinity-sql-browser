# Architecture

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework; state reactivity is `@preact/signals-core`
(ADR-0001), strict TypeScript throughout (ADR-0002). This document reflects
the post-#276 shape: a **modular monolith** — explicit application services and
route-scoped sessions behind a small composition root.

## Layers

```
core/          pure logic (no DOM, no globals, no imports from other layers)
net/           integration: OAuth + the ClickHouse HTTP client (fetch injected via ctx);
               low-level URL/request mechanics delegate to packages/clickhouse-http
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
- `packages/clickhouse-http/src/**` never imports SQL Browser `src/**` and
  has zero bare-specifier imports of its own (an empty allowlist — root
  hoists many runtime dependencies the package must not resolve
  undeclared); `src/**` never deep-imports the package's own `src/**`
  (#630 Phase 2). The package's bare `@altinity/clickhouse-http` import
  (never a deep subpath) splits into two categories since #630 Phase 5:
  transport/protocol APIs (`createClickHouseHttpClient`, `chUrl`,
  `streamLines`, the response consumers, `ClickHouseError`) remain
  restricted to `src/net/**`, exactly as Phase 2 established, no matter
  where the import site lives and no matter whether the reference is a
  value or a type-only one; pure LANGUAGE APIs (SQL quoting, the generic
  type grammar, the shared scanner) may be imported directly by their real
  SQL Browser consumers anywhere outside `src/net/**` too — but only as a
  plain named import (value or type-only) of an approved name; every other
  access form (default/namespace/side-effect/dynamic import, package
  re-export gateway) stays `src/net/**`-only regardless of name or
  type-only-ness. This name/shape-aware half of the rule is a real
  TypeScript parse (`build/lib/check-legacy-owners.mjs`), not a specifier-
  text regex, because a regex cannot tell which names a named import binds.
  The check has no type-only carve-out: a whole `import type`/`export type`
  declaration, or an individual `import { type X }` specifier, naming a
  transport/protocol name is flagged exactly like the value form would be —
  the boundary this rule enforces is a source-level ownership boundary over
  which subsystem may even NAME a transport/protocol export, not a
  bundle-output boundary, so `import type` erasure before bundling
  (esbuild's own elision) does not exempt it even though the package's
  public surface exports transport types (`ClickHouseHttpClient`,
  `ClickHouseHttpRequest`, …) alongside the approved pure-language types
  (`Span`, `TypeNode`, `TypeModifiers`, …). The deep-import-subpath half
  above was always unconditional on `import type` for the identical reason:
  the "only the package's `.` export is public" contract applies to a
  type-only deep import exactly as much as a value one.

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
| `query-execution-service` (`app.exec`) | SQL Browser's own Table/KPI/TSV/explicit-format request mapping and positive-row-cap policy across every branch (#630 Phase 7, moved off the deleted `net/ch-client.ts` `runQuery`); the shared request/stream/normalize read core + the script transport loop (retry classification, stop-on-first-failure, per-attempt `query_id`); owner-scoped best-effort `kill(ownerEpoch, queryId)` — cancellation is caller-owned (`AbortController`s live with the owning session) |
| `connection-session` (`app.conn`) | authoritative auth + connection lifecycle (`starting` / `connected` / `refreshing` / `offline` / `auth-required` / `reauthenticating` / `signed-out`), OAuth PKCE login/refresh, Basic probing, IdP config, identity, token storage, sign-out, and **the single live `chCtx` object** (mutated in place — `authConfirmed` by `net/authenticated-clickhouse-request`, `origin` by sign-in — never reconstructed) |
| `schema-catalog-service` (`app.catalog`) | server version, schema tree, lazy columns, SQL reference/completions, entity-doc cache; catalog/schema/reference/docs transports share a connection-generation abort signal, and `invalidate()` synchronously aborts them while generation fences reject stale writes |
| `workbench-parameter-session` (`app.params`) | `{name:Type}` analysis/prepare/gate policy, input-vs-execute hardening, enum inference, recent values; reads the live shared `AppState` slices through accessors |
| `export-service` (`app.exports`) | direct + script export behind an injectable `ExportSink` (`pickFile`/`pickDirectory`); hold-back exception inspection, `.partial` semantics, its own owner-scoped cancellation state (#630 Phase 7) |
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
`net/authenticated-clickhouse-request` reports only successful 2xx transport
settlement as connected and rejected, non-aborted `fetch` as offline. HTTP query failures — including a
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

`query-execution-service.ts`'s Table branch streams
`JSONStringsEachRowWithProgress` (KPI streams `JSONEachRowWithProgress`)
through `authenticated-clickhouse-request.ts`'s `authenticatedProgress()`,
folded via the pure `applyStreamLine` (**#630 Phase 7** — this mapping used
to live in `net/ch-client.ts`'s `runQuery`, deleted that phase; see its own
section below). A single automatic token refresh on 401/403/
`token_verification_exception` happens one layer down, in
`authenticatedRequest()` (#630 Phase 6): before `authConfirmed` flips, an
auth failure signs out; after, it is a query error.

### Transport seam (#585 Phase 1) and the clickhouse-http package (#630 Phases 2-4)

Generic request construction and stream mechanics are split out behind a
narrow contract: `net/clickhouse-transport.types.ts` declares
`ClickHouseTransport` (`send()` only, since Phase 3 — see below), and
re-exports its `TransportDeps`/`TransportRequest` types as aliases of
`@altinity/clickhouse-http`'s own `ClickHouseHttpClientDeps`/
`ClickHouseHttpRequest`. `net/clickhouse-http-transport.ts`'s
`createHttpTransport` is now a temporary COMPATIBILITY ADAPTER, and is
REQUEST/SEND-ONLY: its `send()` delegates to the package's
`createClickHouseHttpClient(deps).request()` instead of building the request
itself. `chUrl`/`ChUrlOpts`, the low-level `request()`/Fetch invocation, the
progress-bearing JSON-lines read loop (`streamLines`, plus its
`StreamLine`/`StreamCallbacks`/`ProgressMetaColumn` wire types), and the HTTP
exception-text parser + byte-safe late-exception framer
(`parseExceptionText`, `findExceptionFrame`/`ExceptionFrame`) all live in
`packages/clickhouse-http` — the repository's first npm workspace (private,
zero runtime dependencies, zero bare-specifier imports in its own source, no
dependency on SQL Browser `src/**`) — exposed only through its public `.`
export. `ch-client.ts` re-exports `chUrl`/`parseExceptionText`/
`findExceptionFrame`/`StreamLine`/`StreamCallbacks`/`ChUrlOpts` from that
package unchanged, as zero-logic migration plumbing for existing importers
(including `export-service.ts`'s `findExceptionFrame` use, since
`src/application/**` cannot import the package directly). `build/check-
boundaries.mjs` mechanically restricts the bare `@altinity/clickhouse-http`
import to `src/net/**`, bans any deep import into the package's `src/**`
implementation (from either side), and — since Phase 3 — mechanically
rejects the three former owners (the transport adapter, the transport
contract, `core/stream.ts`) regaining any of the identifiers moved out of
them, so the network-layer boundary can't be bypassed just because the
mechanics moved behind a package name, and no duplicate stream/exception
implementation can silently reappear. Through Phase 5, `ch-client.ts` kept
every auth/epoch/retry/lifecycle policy (`authedFetch`), product operation,
and `ChCtx` exactly as before; a module-private `transportFor(ctx)` delegated
unconditionally to `createHttpTransport` for the request/send half — `ChCtx`
gained no field and there was no runtime transport switch. (**#630 Phase 6**,
documented in its own section below, later moves that auth/epoch/retry/
lifecycle policy itself out of `ch-client.ts` into a new module.) At this
point, `runQuery` (itself under `src/net/**`) called the package's
`streamLines` directly rather than going through the transport seam, since
there is exactly one production stream implementation and no longer a stream
member on the contract — **#630 Phase 7** later deletes `runQuery` outright
and moves that direct-`streamLines`-via-`authenticatedProgress()` call into
`query-execution-service.ts` (its own section below). Through
Phase 5, `authedFetch` snapshotted the caller's `settings`/`params`
synchronously at entry, before its first await, calling the package's
`chUrl` directly as an eager pre-credential preflight (a malformed value
throws synchronously here, before any token read), as one centralized
defense against a caller mutating those objects while a token/refresh await
is pending — the low-level `request()`/`send()` API instead resolves this
same failure as a REJECTED promise, since both remain `async`. (Phase 6
moves this exact preflight verbatim into the new authenticated module.) A
reusable contract-test-suite factory
(`tests/unit/clickhouse-transport-contract.ts`) is now request/send-only and
registers against both the package's own `request()` and the compatibility
adapter; the progress-stream loop is tested once, directly against the
package's `streamLines` (`tests/unit/clickhouse-http-progress-stream.test.ts`),
and the exception parser/framer once, directly against the package
(`tests/unit/clickhouse-http-exceptions.test.ts`) — deliberately not
dual-registered, since there is intentionally only one production
implementation of each. A future official-client implementation (ADR-0005 is
Rejected; that cutover does not proceed without a new decision) would
satisfy the same `ClickHouseTransport` contract and reuse the same suite.

SQL Browser still owns everything downstream of the wire: `core/stream.ts`
keeps `StreamResult`, row caps, progress/percentage folding, and in-band
exception → `result.error` (`applyStreamLine`, now narrowed to accept an open
`Record<string, unknown>` parsed-record boundary rather than re-declaring a
second copy of the package's `StreamLine` wire type), plus editor-caret
(`parseErrorPos`) and auth-expiry/denial (`isAuthExpiredBody`,
`authDeniedMessage`) UI policy. `export-service.ts`'s `streamToFile` calls
the package's byte-oriented `findExceptionFrame` directly on its retained
`Uint8Array` holdback — the caller-side latin1 conversion it used to carry
is gone, since the package computes byte-exact offsets internally.

**Phase 4** adds purely additive consuming query APIs and a stateless
`KILL QUERY` on top of the unchanged `request()` — no `src/**` caller
consumes any of this yet (that cutover is a later phase). The layering:

```
request()
  -> ensureClickHouseSuccess()
  -> consumeJson/Text/ProgressResponse()
  -> queryJson/queryText/queryProgress
  -> stateless killQuery
```

`response.ts` adds `ensureClickHouseSuccess(response)`: on a 2xx response it
returns the SAME `Response` by strict identity, never cloning or reading its
body (`bodyUsed` stays `false`); on a non-2xx response it reads the complete
error text exactly once and throws the new minimal `ClickHouseError`
(`status`, exact `responseText`, a `message` derived from the existing
`parseExceptionText` — never `findExceptionFrame`, which stays Phase-3's
late-success-stream mechanic). `consumeJsonResponse`/`consumeTextResponse`/
`consumeProgressResponse` each compose that classifier with exactly one
further native operation (`.json()`/`.text()`/`streamLines()`) — no retry, no
extra try/catch, so a native network/abort/body-reader error always
propagates unwrapped, and a successful in-band `{"exception": ...}` progress
line remains ordinary `onLine` callback data, never a thrown error.
`client.ts` extends `ClickHouseHttpClient` with `queryJson`/`queryText`/
`queryProgress` — each one `client.request(...)` call plus one matching
consumer, so every convenience method makes exactly one Fetch. Only
`queryJson` defaults its `defaultFormat` (via `??`, to `'JSON'`, only when
omitted); `queryText`/`queryProgress` require an explicit wire format and
apply no SQL Browser Table/KPI/TSV mapping — a literal format string is
opaque wire data to the package. `killQuery` is a genuinely stateless
wire-level `KILL QUERY WHERE query_id = <quoted> ASYNC`, built from one
`queryText()` call: no credential lookup, refresh, epoch, lifecycle
callback, retry, or query registry of its own, and it never writes its SQL
target into the HTTP request's own `params.query_id`. Its own private
`quoteKillQueryId` reproduces only `src/core/format.ts`'s `sqlString()`
backslash-then-quote escaping convention as a narrow, unexported Phase-4
stopgap — **Phase 5** replaces it with the package's own shared public
string-literal quoting API (below). At this point (Phase 4) root
`killQuery`/`killQueryWithLease` and `queryJson`/`runQuery`/`exportQuery`
were unaffected: they continued to reach `authedFetch`'s auth/epoch/retry
policy exactly as before, and none of them had been migrated onto the new
package consuming-query APIs. **Phase 6** (below) moves that auth/epoch/
retry/lifecycle policy to a new module and switches `queryJson` onto its
JSON response consumer; `runQuery`/`exportQuery`'s consuming-query-API
cutover, and the remaining `killQuery`/`killQueryWithLease` migration,
happened in **Phase 7** ("Query execution and export migration" below):
both generic functions are deleted outright, not superseded by a forwarding
wrapper.

### SQL quoting and the generic type grammar (#630 Phase 5)

Phase 5 moves SQL Browser's ClickHouse SQL string-literal/identifier quoting
and its generic type-expression grammar into `@altinity/clickhouse-http`,
alongside the shared lexical scanner that grammar's dependency closure
requires:

```
sql-quote.ts        sqlString / quoteIdent / qualifyIdent   (the ONE quoter)
clickhouse-type.ts   parseClickHouseType / analyzeTypeModifiers /
                     canonicalType / wrapper+enum helpers    (the ONE grammar)
sql-spans.ts         scanSpans / Span / SpanKind              (the ONE scanner,
                     re-exported — surviving SQL Browser SQL-analysis
                     modules outside src/net/** still need it)
quoted-span.ts       scanDelimited                           (package-private;
                     not re-exported — only the two package modules above
                     import it, relatively)
```

Every real former SQL Browser owner of these mechanics is retargeted, not
duplicated: `src/core/format.ts` no longer declares
`sqlString`/`BARE_IDENT`/`quoteIdent`/`qualifyIdent` at all (no forwarding
alias either), and `src/core/clickhouse-type.ts`/`sql-spans.ts`/
`quoted-span.ts` are deleted outright. `packages/clickhouse-http/src/client.ts`'s
`killQuery` now quotes its SQL target with the package's own `sqlString`
(imported relatively, package-internal); the Phase-4 private
`quoteKillQueryId` stopgap is gone. Every real production consumer imports
directly from the package's public `.` export: `src/net/ch-client.ts`,
`src/ui/app.ts`, `src/core/variable-options.ts`, `src/core/completions.ts`,
`src/ui/schema.ts`, `src/ui/schema-detail.ts`, `src/ui/explain-graph.ts`,
`src/core/param-type.ts`, `src/core/kpi.ts`, `src/core/dashboard-variables.ts`,
and the scanner's other surviving consumers (`src/core/sql-lex.ts`,
`sql-split.ts`, `param-scan.ts`, `type-display.ts`, `optional-blocks.ts`,
`format.ts` itself). `isSupportedOptionScalar` — SQL Browser option/control
policy over which scalar families are eligible for an option-backed control,
not generic grammar — moved to `src/core/param-type.ts` instead, the package
never exports it. SQL Browser's own display/FORMAT/parameter-control/KPI/
Dashboard-variable policy is otherwise untouched: only the underlying generic
mechanics changed owner, never their behavior — the existing parser/helper
bodies moved, they were not redesigned.

This is the phase that requires Rule D (above) to distinguish transport/
protocol package exports from pure-language ones, since SQL Browser
language consumers now legitimately import the package from outside
`src/net/**` — see the boundary rule text above for the mechanics.

### Authenticated request layer (#630 Phase 6)

Phase 6 moves the SQL Browser normal-request auth/epoch/refresh/lifecycle
policy — `authedFetch()` and the module-private, `ChCtx`-based
`transportFor(ctx)` — out of `ch-client.ts` into a new module,
`src/net/authenticated-clickhouse-request.ts`. This is a real move+delete,
not an additive layer: both are gone from `ch-client.ts`, with no
forwarding alias, no second retry loop, and no second Authorization
constructor.

```
authenticatedRequest(ctx, request)     the moved trust-boundary loop —
                                        credential acquisition, epoch
                                        fencing, one-refresh retry,
                                        connect/offline/sign-out
                                        classification — over the
                                        package's client.request()
authenticatedJson(ctx, request)        authenticatedRequest() + package
                                        consumeJsonResponse()
authenticatedText(ctx, request)        authenticatedRequest() + package
                                        consumeTextResponse()
authenticatedProgress(ctx, request, cbs) authenticatedRequest() + package
                                        consumeProgressResponse()
```

The module builds the package client directly
(`createClickHouseHttpClient({ fetch: () => ctx.fetch, origin: () => ctx.origin })`)
once per `authenticatedRequest()` invocation, before the retry loop, and
calls `client.request()` on every attempt — never `client.queryJson`/
`queryText`/`queryProgress`: those convenience methods build a request from
an already-resolved Authorization and give this layer no chance to inspect
the settled `Response` before deciding whether a refresh/retry is
authorized, which is exactly the policy this module owns. The eager,
discarded `chUrl(...)` pre-credential preflight, the per-attempt complete
Authorization construction, the final epoch fence immediately before
`client.request()`, and every fence after a credential/body await all move
verbatim from the old `authedFetch()`.

`AuthenticatedRequestCtx` is a narrow base seam — only the fields this
module actually needs (`fetch`, `origin`, `getToken`, `refresh`,
`onSignedOut`, and the optional `authHeader`/`authConfirmed`/
`currentEpoch`/`onTransportConnected`/`onTransportOffline`). `ch-client.ts`'s
own `ChCtx` now `extends AuthenticatedRequestCtx` instead of redeclaring its
fields, adding only `dataLakeCatalogSettingUnsupported` — the one field
genuinely specific to this product client, kept out of the auth module on
purpose. `AuthenticatedCancellationLease` stays exported from `ch-client.ts`
unmoved: relocating it was not required to satisfy this phase and would
have created unrelated application import churn.

`queryJson()` is the first real production consumer of the package's
response-consumer layer: it now delegates to `authenticatedJson()`,
translating the package's `ClickHouseError` back to `queryJson`'s EXISTING
plain-`Error` compatibility shape — same parsed message (both are derived
from the same `parseExceptionText`), different error class — so this phase
adopts the new consumer without changing an existing SQL Browser API.
`runQuery()`/`exportQuery()` switch only their `authedFetch()` call to the
new raw `authenticatedRequest()` entrypoint, keeping their own Table/KPI/raw
format mapping, row-cap settings, non-2xx parsing, and streaming exactly as
before. `killQuery()` inherits the new path indirectly through `queryJson()`.
(**#630 Phase 7** deletes all three of `runQuery`/`exportQuery`/this
ordinary `killQuery` outright once their SQL Browser policy moves to
`query-execution-service.ts`/`export-service.ts` — see below.)
`killQueryWithLease()`'s frozen-lease bypass is untouched: it already built
its own one-shot transport directly from the frozen lease's exact origin/
Authorization/Fetch authority, never through `ChCtx`, so it does not — and
must not — route through the new mutable-context auth loop.

`build/check-boundaries.mjs`'s two existing #585 transport-leaf forbidden
lists (`clickhouse-http-transport.ts`, `clickhouse-transport.types.ts`, both
above) and the #512 `connectionAuthorityFiles` lifecycle-authority list now
name `authenticated-clickhouse-request.ts` as the current auth/lifecycle
owner they must not reach or regain, alongside `ch-client.ts` (kept through
Phase 7). This is a data extension of two existing dependency rules plus one
existing lifecycle-authority list — no new scanner.

**#630 Phase 7** (below) completed this deferred work: `runQuery`/
`exportQuery`'s cutover onto SQL Browser's own `query-execution-service.ts`/
`export-service.ts` policy layers (not the package's convenience consuming
query APIs — `queryJson`/`queryText`/`queryProgress` still have no `src/**`
consumer, Phase 8's concern), the `killQuery`/`killQueryWithLease` transport
migration onto the package's own stateless `killQuery`, and deletion of the
now-superseded `clickhouse-http-transport.ts`/`clickhouse-transport.types.ts`
compatibility seam — which had been kept alive by `killQueryWithLease` and
by the real-browser harness's raw/unauthenticated scenarios through Phase 6.
See "Query execution and export migration (#630 Phase 7)" below.

### Query execution and export migration (#630 Phase 7)

Phase 7 moves SQL Browser's own request-shape and row-cap policy out of
`net/ch-client.ts` and into the two application services that already
owned everything downstream of it, then deletes the generic mechanics those
services used to call through.

`query-execution-service.ts` no longer takes a `ctx()` auth-context
provider at all — it is injected exactly three narrow authenticated
primitives instead: `runProgress` (streaming Table/KPI reads), `runText`
(whole-body TSV/explicit-format reads, plus every script statement, effect
or row-returning alike), and `cancel` (owner-scoped best-effort
`KILL QUERY`). It now OWNS the Table/KPI/TSV/explicit-raw format→settings
mapping that used to live inside `runQuery`
(`JSONStringsEachRowWithProgress`/`JSONEachRowWithProgress` for Table/KPI
with no `wait_end_of_query`; `TabSeparatedWithNamesAndTypes`/the caller's
own format for TSV/explicit-raw with `wait_end_of_query=1`;
`add_http_cors_header=1` on every branch). `runQuery` itself already
computed a positive ordinary `resultRowLimit`'s
`max_result_rows`/`result_overflow_mode=break` cap independently of format
and spread it into `settings` uniformly for every branch — QES's rewrite
preserves that exact behavior on ALL FOUR branches (Table/KPI/TSV/
explicit-raw), and adds the per-branch regression coverage that behavior
never previously had at this granularity, including a dedicated
explicit-FORMAT-with-row-limit case (an explicit-FORMAT SELECT such as
`FORMAT CSV` gets the same server-side cap a Table result does) — guarding
against a future rewrite naively scoping the cap to only Table/KPI. Only a
caller that deliberately passes `0` (EXPLAIN/PIPELINE/ESTIMATE) stays
uncapped. The script transport loop's own `SELECT_ROW_CAP` over-fetch stays
exactly where it was: in `params`, spread after `stmt.params` so it always
wins a collision, and never duplicated into `settings`.

`export-service.ts` is injected two narrow authenticated primitives the
same way — `exportResponse` (the raw native `Response`, for both the
single-file export and a script's row-returning statements) and
`runEffectText` (a script's non-row effect statements) — plus the same
`cancel` callback QES uses. Its `ctx()` dependency narrows to a
`SignedOutCtx` (`onSignedOut()` only): no export path reads mutable `ChCtx`
for a transport call any more. Pre-header failure classification is now the
package's own `ensureClickHouseSuccess()`, reached through
`authenticatedResponse()` (below) — `ExportService` no longer does its own
`resp.ok`/`resp.text()` check, and no writable/read loop starts for a
failed status. The successful `Response`, its raw-byte streaming
(`body.getReader()`, the 32 KiB hold-back, `findExceptionFrame` on the
retained tail, `.partial` on incomplete data), and export UX
(picker/progress ordering) are all unchanged from before Phase 7 — only how
the `Response` is obtained and classified moved.

`authenticated-clickhouse-request.ts` gains a fourth wrapper,
`authenticatedResponse(ctx, request)`: `authenticatedRequest()` + the
package's `ensureClickHouseSuccess()` — the exact successful `Response` by
identity (`bodyUsed` stays `false`), a thrown package `ClickHouseError` on
a non-2xx, native abort/network failures propagating unmodified, no retry
added. `src/ui/app.ts`'s composition root wires `runProgress`/`runText` over
`authenticatedProgress`/`authenticatedText` (unchanged from Phase 6) and
`exportResponse`/`runEffectText` over the new `authenticatedResponse`/
`authenticatedText`, plus one new shared callback,
`cancelOwnedQuery(ownerEpoch, queryId)` — QES's `kill()`, the workbench
session's cancel, and both `ExportService` cancel paths (direct export,
export script) all delegate to this single function rather than each
building their own `killQueryWithLease` call. It captures a lease at
`conn.captureCancellationLease(ownerEpoch)` and, only if one is returned,
calls `ch.killQueryWithLease(lease, queryId)`.

`ConnectionSession.captureCancellationLease` widens to take an optional
`expectedEpoch` parameter (default: the current epoch) without changing its
existing internal semantics: a caller holding an older operation's owner
epoch gets `null` — not the live credential — once the session has since
moved to a REPLACEMENT epoch (a new sign-in or an auth-required
transition), while a same-epoch refreshed credential still succeeds.
Callers capture their own owner epoch once, at operation registration/start
time (the workbench session's `ActiveRun.ownerEpoch`, `ExportService`'s
`exportOwnerEpoch`/`exportScriptOwnerEpoch`), never re-reading it at cancel
time.

`ch-client.ts`'s `killQueryWithLease` is rewritten onto the package's own
stateless kill instead of the local transport adapter:

```ts
const client = createClickHouseHttpClient({ fetch: () => lease.fetch, origin: () => lease.origin });
await client.killQuery({ queryId, authorization: lease.authorization });
```

The exact same invariant Phase 6 already established for this bypass still
holds: no `ChCtx`/token lookup, no refresh, no lifecycle callback, no
retry — the frozen lease's own `fetch`/`origin`/`authorization` are the
only inputs — and the package (not this call site) now owns the
`KILL QUERY` SQL and its quoting, so `killQueryWithLease` drops its
`sqlString` parameter. The ordinary mutable-context
`killQuery(ctx, queryId, sqlString)` `ch-client.ts` used to export is
deleted outright — no forwarding wrapper.

With QES, `ExportService`, and both export cancellation paths migrated off
them, the generic `runQuery`/`RunQueryOptions`/`RunQueryResult`,
`exportQuery`/`ExportQueryOptions`, and the ordinary `killQuery` are deleted
from `ch-client.ts`, and `src/net/clickhouse-http-transport.ts`/
`clickhouse-transport.types.ts` — the local compatibility transport seam
Phase 3 introduced and Phase 6 left with `killQueryWithLease` as its one
remaining caller — are deleted outright, along with
`tests/unit/clickhouse-http-transport.test.ts`. There is now exactly one
generic ClickHouse HTTP transport implementation in the repository: the
package's. `tests/e2e/clickhouse-http-transport.{html,spec.js}`'s generic
request/progress scenarios retarget onto the package's own
`createClickHouseHttpClient(...).request()` directly, preserving every
original behavioral assertion (identity, call count, exact SQL/
Authorization, cancellation semantics, byte fidelity) — Scenario 9 remains
`queryProgress()` coverage, not export coverage.

`build/check-boundaries.mjs`/`build/lib/check-legacy-owners.mjs` gain two
new resurrection guards: a path-existence check that fails if either
deleted transport file reappears in any form (even empty, even
reimplemented under a different name), and
`findRetiredTopLevelApiViolations` — a real-parser check scoped to a
module's OWN top-level statements (declarations, import/export bindings),
never descending into function/class/block bodies — banning top-level
`runQuery`/`RunQueryOptions`/`RunQueryResult`/`exportQuery`/
`ExportQueryOptions`/ordinary `killQuery` from returning anywhere under
`src/**`. Because it is declaration-scoped rather than a blanket identifier
walk, it cannot reject the legitimate surviving `client.killQuery(...)`
member call inside `killQueryWithLease` itself — a property access is
never a top-level statement, so no name-based carve-out is needed.
`tests/unit/clickhouse-http-package-policy.test.js`'s Phase 3 former-owner
registry (`PHASE3_LEGACY_OWNER_FILES`) stays exactly as it was — it is a
historical record of former owners, not a claim any of them still exist —
but the suite's own unconditional file-read loop is replaced with explicit
assertions that the two Phase 7 files are absent and that the surviving
`src/core/stream.ts` still carries no moved-name violations.

A new real-browser (Chromium and WebKit) e2e fixture,
`tests/e2e/export-post-header-cancel.{html,spec.js}`, proves native
post-header cancellation semantics through the ACTUAL export path — real
`createExportService`/`authenticatedResponse`/`window.fetch`/
`AbortController`/raw stream loop/owner-scoped cancellation, with an
in-page fake file handle standing in only for the File System Access API —
rather than the generic transport harness's own synthetic scenarios: a
first chunk past the 32 KiB hold-back forces an actual file write before
the fixture holds the next read pending and cancels mid-read, proving the
pending read aborts, no later write/progress occurs, writer cleanup and
`.partial` still happen, and the correct owner epoch/query ID reach remote
cancellation.

`tests/spike/clickhouse-client/run-matrix.mjs`'s deletion-estimate
classification — which exhaustively classifies every `ch-client.ts`
top-level symbol and throws on a stale entry — is reconciled with the
post-cutover tree: the retired symbols' classifications and the
transport-file disk read are removed, and the estimator manifest/formula
match the surviving declarations. The historical #585 evidence corpus is
not regenerated just because the executable estimator changed. The spike
tree's other consumers (`current-adapter.ts`, `official-adapter.ts`,
`parity.test.ts`, `live-sessions.test.ts`) are retargeted off the retired
`runQuery`/`exportQuery`/`killQuery` types onto the Phase 7 production
seams/QES dependency shape, without otherwise redesigning the official-
client spike (that stays out of scope for this phase).

Claims **A14** (QueryExecutionService owns format/cap/retry policy with no
generic HTTP/stream mechanics of its own), **A15** (ExportService receives
an authenticated native `Response`, streams bytes, and proves post-header
cancellation in both required browsers), and **A16** (the generic
run/export/ordinary-kill APIs and both local transport files are gone,
with architecture guards preventing their return).

### Standalone package build and final retirement (#630 Phase 8)

Phase 8 (the final phase of issue #630) claims **A17**/**A18** and closes
the issue.

**A17 — independently buildable/packable/typecheckable, no root-source
fallback.** `packages/clickhouse-http` gets its own build/type/test
boundary, entirely package-local:

```
package source (src/**/*.ts)
     |
     +-- package-local esbuild (bundle: false, platform: browser,
     |   format: esm, outbase: src, outdir: dist)
     |         -> packages/clickhouse-http/dist/**/*.js
     |
     +-- package-local tsc (declaration-only emit)
               -> packages/clickhouse-http/dist/**/*.d.ts
                        |
                        +--> root tsc resolves dist declarations
                        |    (root tsconfig.json no longer includes
                        |    package src/**/*.ts at all)
                        |
                        +--> root esbuild resolves dist ESM through the
                             workspace node_modules symlink (attributed to
                             the `project` ownership bucket by
                             build/size-report-lib.mjs, never `external`,
                             since it is project code either way)
                                        |
                                        v
                                   dist/sql.html
```

The package manifest's `main`/`types`/`exports["."]` all target `dist/**`,
never source — the SAME public surface an eventual extraction (#639) or
external consumer would see. Every production build entrypoint that
bypasses root npm scripts (`build/bundle.sh` and `deploy/install.sh`, both
of which call `node build/build.mjs` directly) gets an explicit
`npm --prefix "$ROOT" run build:clickhouse-http` line before that call, so
the package's own `dist/**` genuinely exists first, in every real
invocation path — verified from a clean `packages/clickhouse-http/dist`
state for both wrappers. `packages/clickhouse-http/test/isolated-package.mjs`
(`npm run test:pack`) is a real, runnable proof: build the package, run a
real `npm pack`, install the tarball into a fixture OUTSIDE this
repository, import it as ESM, and compile a TypeScript consumer against its
declarations with `--traceResolution` — asserting neither runtime nor type
resolution ever falls back into this repository's source.
`packages/clickhouse-http/test/browser/**` is a new first-party
Chromium+WebKit regression suite serving the package's own generated
`dist/**` directly (no import map, no vendor client, no Docker/live
ClickHouse) — see `docs/clickhouse-http-repository-extraction.md` for the
full extraction handoff (#639).

**A18 — final ownership cleanup and vendor retirement.** The migration-only
`ch-client.ts` forwarding aliases (`chUrl`/`parseExceptionText`/
`findExceptionFrame`) are removed now that every spike consumer is gone;
`export-service.ts` imports `findExceptionFrame` directly from the package
under one narrow, named Rule-D exception
(`PHASE8_NARROW_RULE_D_EXCEPTIONS`) rather than through that retired
gateway — no other application module gets protocol/client access. Five
architecture guards are added/broadened, all through the same real-parser
mechanism (`build/lib/check-legacy-owners.mjs`), never a hand-rolled
regex/text scanner: package containment now also covers the package's own
`test/**`/`build.mjs`/`vitest.config.ts` (Guard 1); the package
relative-deep-import ban widens from `src/**` to the whole package
directory, closing a `dist/**` escape a source-only ban would have missed
(Guard 2); root-wide declaration/re-export ownership for the historical
`chUrl`/`createHttpTransport`/`ClickHouseTransport`/`TransportDeps`/
`TransportRequest` transport surface, exempting the sanctioned package
import itself (Guard 3); the same root-wide ownership rule for the moved
progress-stream/exception-parsing primitives (Guard 4); and the
`@clickhouse/client-web` ban's former "future official transport file"
allowlist is deleted outright, its scan widened across
`src/**`/`packages/clickhouse-http/**` (excluding generated `dist/**`)/
`tests/**`/`build/**`, plus structural manifest/lock/script/directory
checks (Guard 5). The `@clickhouse/client-web` devDependency, its four npm
scripts, and the whole executable `tests/spike/clickhouse-client/**`
directory are removed per an exact file-by-file disposition table (mostly
outright deletion; `fault-server.mjs` moves to the package's own browser
suite as generic, dependency-free fixture infrastructure; its former
first-party consumer splits into that package suite plus a narrower root
`tests/e2e/authenticated-clickhouse-request.{html,spec.js}` for SQL
Browser's own authentication-policy variants) — along with the
candidate-build-only `additionalNotices`/`--notices` plumbing in
`build/build.mjs`/`build/size-report.mjs`. `docs/evidence/585/**` and
ADR-0005's Rejected decision/historical content are untouched; only a
narrow current-state addendum documents the executable retirement.

At this point issue #630 itself is complete; issue #639 (external
repository creation/release and the SQL Browser consumer cutover) starts
from the tested handoff in
`docs/clickhouse-http-repository-extraction.md`.

## Build

`build/build.mjs` runs esbuild (bundle + minify, IIFE), inlines the script and
`styles.css` into `build/template.html` → a single `dist/sql.html`. Seven
bundled runtime dependencies (CodeMirror 6, Chart.js +
chartjs-adapter-date-fns + date-fns, dagre, `@preact/signals-core`, marked);
none is loaded from a third-party CDN. `packages/clickhouse-http` (#630
Phase 2, the repository's first npm workspace; independently built since
Phase 8 — see above) is first-party project source, not an eighth runtime
dependency — esbuild resolves its bare `@altinity/clickhouse-http` import
through the workspace's `node_modules` symlink to its BUILT `dist/**`
(never source, since Phase 8) and bundles that as ordinary project code;
`build/size-report-lib.mjs` attributes every `packages/**` input to the
`project` ownership bucket accordingly, and the Dockerfile's build stage
copies `packages/` alongside `src/` before `npm ci && npm run build` (which
itself composes `build:clickhouse-http` first) so container/release builds
resolve it identically.
