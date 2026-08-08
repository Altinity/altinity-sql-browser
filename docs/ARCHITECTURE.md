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
| `query-execution-service` (`app.exec`) | the shared request/stream/normalize read core + the script transport loop (retry classification, stop-on-first-failure, per-attempt `query_id`); stateless `kill(queryId)` — cancellation is caller-owned (`AbortController`s live with the owning session) |
| `connection-session` (`app.conn`) | authoritative auth + connection lifecycle (`starting` / `connected` / `refreshing` / `offline` / `auth-required` / `reauthenticating` / `signed-out`), OAuth PKCE login/refresh, Basic probing, IdP config, identity, token storage, sign-out, and **the single live `chCtx` object** (mutated in place — `authConfirmed` by `net/authenticated-clickhouse-request`, `origin` by sign-in — never reconstructed) |
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

`runQuery` in `net/ch-client.ts` streams `JSONStringsEachRowWithProgress`,
folded via the pure `applyStreamLine`; a single automatic token refresh on
401/403/`token_verification_exception` (before `authConfirmed` flips, an auth
failure signs out; after, it is a query error).

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
lifecycle policy itself out of `ch-client.ts` into a new module.) `runQuery`
(itself under `src/net/**`) calls the package's `streamLines` directly rather
than going through the transport seam, since there is exactly one production
stream implementation and no longer a stream member on the contract. Through
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
stay Phase 7.

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

Deferred to **Phase 7**: `runQuery`/`exportQuery`'s cutover onto the
package's consuming query APIs and result/export ownership, the remaining
`killQuery`/`killQueryWithLease` transport migration, and deletion of the
now-superseded `clickhouse-http-transport.ts`/`clickhouse-transport.types.ts`
compatibility seam (still used by `killQueryWithLease` and by the real-
browser harness's raw/unauthenticated scenarios through Phase 6).

## Build

`build/build.mjs` runs esbuild (bundle + minify, IIFE), inlines the script and
`styles.css` into `build/template.html` → a single `dist/sql.html`. Seven
bundled runtime dependencies (CodeMirror 6, Chart.js +
chartjs-adapter-date-fns + date-fns, dagre, `@preact/signals-core`, marked);
none is loaded from a third-party CDN. `packages/clickhouse-http` (#630
Phase 2, the repository's first npm workspace) is first-party project
source, not an eighth runtime dependency — esbuild resolves its bare
`@altinity/clickhouse-http` import through the workspace's `node_modules`
symlink and bundles it as ordinary source; `build/size-report-lib.mjs`
attributes every `packages/**` input to the `project` ownership bucket
accordingly, and the Dockerfile's build stage copies `packages/` alongside
`src/` before `npm ci && npm run build` so container/release builds resolve
it identically.
