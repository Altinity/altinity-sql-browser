# Decisions and roadmap

Back to [[Home]]. Related: [[Architecture]], [[Development-Workflow]].

## Settled decisions

- Incrementally use `@preact/signals-core`; do not introduce a UI framework.
  **Reaffirmed 2026-08-03** by ADR-0004: a whole-shell-scale Preact migration
  evaluation (#577) was measured and rejected — see below.
- Keep CodeMirror 6 behind `EditorPort` and never run SQL on the keystroke path.
- Keep complex/high-frequency UI islands imperative behind injected seams.
- Extract a shared UI primitive when a second real consumer appears, not before.
- Keep the product a single esbuild artifact with zero third-party requests.
- Use comment-wrapped optional SQL blocks (`/*[ ... ]*/`) for empty-means-no-filter;
  the earlier double-square-bracket form conflicted with ClickHouse array syntax.
- The panel configuration registry is the common model for chart/table/logs/KPI/
  filter/text views and library persistence.
- **Contracts specify final-state invariants**, not frame-by-frame gesture
  behavior, unless a user-visible bug forces otherwise — the retrospective
  lesson of ADR-0004 (see below), now also a `CLAUDE.md` Working-discipline rule.

## ADR-0004: the Preact evaluation (#577) — retain vanilla, reject the migration

`#487` (left navigation) and `#488` (right inspector) both pushed on the same
pressure point: increasingly complicated lifecycle/focus coordination in the
hand-rolled `src/ui/` render layer. `#577` asked, with a decision rule fixed
*before* measuring, whether replacing it with Preact would make the shell
materially smaller and simpler. Three tagged, never-merged branches (S0
baseline, S1 vanilla control, S2 Preact treatment — tags `577/baseline`,
`577/control`, `577/treatment`; evidence archived on branch
`docs/preact-shell-evaluation-577`, closed PR #580) were measured together over
one 18-entry file manifest.

**Result (2026-08-03): RETAIN vanilla rendering, REJECT the migration.** The
treatment cost +330 shell-plumbing code lines (+26% over the control) and
+7,755 B gzip, with domain/island line counts unchanged across all three
states — a clean failure of the precommitted code-dominance rule. `#578` (the
phased migration umbrella) closed as **not planned**; the investment redirects
to shared *vanilla* shell primitives instead:

- **#586** — one `SurfaceLifecycle` primitive + a docked right-inspector slot
  (the mount/update/dispose contract #488 needs).
- **#587** — a side-panel registry, so a new navigation panel is a one-file
  change.
- **#588** — decompose the composition root (`src/ui/app.ts`, `createApp`
  spans ~3,000 lines) along four seams.
- **#589** — extract the dashboard tile gesture controller and a pure repaint
  plan out of imperative handlers.

Full method, measurements, and retrospective lessons (async DOM-vs-state
writes, a silent-dead-reactivity footgun from importing the wrong signals
package, derived state having no "gesture ended" edge, two regressions e2e
caught that 6,995 green unit tests missed): canonical source
[`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md).

## The 2026-08-03 main reset — #487 phases 1–3

`#487`'s phases 1–3 — PRs **#571** (left-nav layout core), **#573** (nav-section
registry), **#574** (left-rail focused drawer) — **merged into `main`** on
2026-07-29/30 and show as MERGED on GitHub, but `main` was **reset on
2026-08-03 to a pre-#487 baseline** during the #577 evaluation window. That
code is **not on `main` today**, but it is not lost — it survives, unmerged,
on:

- `feat/left-nav-layout-core-487p1` — pure `core/left-nav-layout.ts` reducer,
  three-layout resize session.
- `feat/nav-section-registry-487p2` — registry decisions (icon-as-factory,
  separate `accessibleLabel`, pane-scoped `showSection`, load-boundary key
  bridge), now being adapted by #587.
- `feat/left-rail-focused-drawer-487p3` — rail/focused-drawer geometry, 180px
  drawer floor, per-section filters.

`#487`'s and `#488`'s issue bodies were rewritten 2026-08-03: the frame-level
focus contract was trimmed to final-state rules, and implementation is now
routed through #586/#587 rather than re-derived independently. Before
resuming #487/#488 work, salvage the branches above rather than re-deriving
proven pure-logic/geometry work; do not assume "merged PR" on GitHub means
"present on `main`" for anything from this window without checking.

## Forward work

Two roadmap tracks are current:

- **V1 roadmap — GitHub issue #68** ("Roadmap to 1.0.0") — the original
  structured feature-issue roadmap; still authoritative for V1-scoped work not
  superseded by V2. Historical Phase 7 ordering recorded here at wiki creation
  (2026-07-12) was #173 → #165 → #170 → #169 → #171/#172, with dashboard filter
  panel work tied to #166 and #160 — re-verify current state on GitHub rather
  than trusting this order today.
- **V2 roadmap — GitHub issue #582** ("Roadmap to V2 (professional UI
  redesign)") — scoped 2026-07-31; supersedes #68 for V2-scoped surfaces only
  (most V1 functionality carries over unchanged). Companion working document:
  [`docs/V2-UX-HANDOVER.md`](../docs/V2-UX-HANDOVER.md), a shipped-UX +
  committed-product-contract inventory for handoff to the redesign.
- **Refactor/umbrella track — #593** ("Umbrella: V2 architecture refactor —
  shell primitives, composition root, state reactivity, transport adapter")
  sequences the ADR-0004 follow-through into one ordered `/ship` execution
  plan, phase by phase (shipped under the pre-2026-08-05 per-phase-PR flow;
  `/ship` now integrates units onto one branch/PR per run): Phase 1
  #586 (`SurfaceLifecycle` + docked right-inspector slot, unblocks #488),
  Phase 2 #587 (side-panel registry, unblocks #487, salvages
  `feat/nav-section-registry-487p2`/PR #573), Phase 3 #591 (fail-closed
  decoders for persisted domain records — independent early win), Phase 4
  #588 (composition-root decomposition), Phase 5 #589 (dashboard gesture/
  repaint extraction), Phase 6 #590 (implemented on `wip/590-reactive-workspace`
  — `app.currentWorkspace`/`app.mainSurface` are signal-backed accessor pairs,
  `dashboardTreeRevision` is retired; see `docs/ADR-0001-reactivity.md`'s #590
  addendum), Phase 7 #585/ADR-0005 — **decided 2026-08-06: Rejected; briefly
  amended 2026-08-07 to "Accepted"; reverted the same day to Rejected** after a
  Phase 2 implementation attempt surfaced a disqualifying cancellation-model
  incompatibility (the `@clickhouse/client-web` transport spike; independent
  of the shell track; Phase 0 completed, Phase 1 landed, Phase 2 attempted
  and blocked, Phases 2-4 do not proceed without a new decision — see below).
  #592 (extend `check-boundaries` to lock in the shell primitives) is a
  guardrail issue alongside the phases. All are labeled `refactor`; re-check
  `gh issue list --label refactor` for the current phase status before
  planning shell work.
- **#585 / ADR-0005 — Rejected (2026-08-06; briefly "Accepted" 2026-08-07;
  reverted to Rejected the same day).** The Phase 0 validation spike
  (`docs/ADR-0005-clickhouse-web-client.md`) compared
  `@clickhouse/client-web@1.23.1` against the current custom transport over a
  reusable parity/precision harness (`tests/spike/clickhouse-client/`). The
  original 2026-08-06 run reached Rejected on two of ten hard gates (a third,
  the browser matrix, was a WebKit flake — root-caused as this sandbox's
  Docker-contention flakiness, fixed via retries + honest flaky-cell
  recording (PR #624), and re-verified clean 16/16): the supported-server
  matrix (both proposed-oldest ClickHouse 24.8.x rows fail — a genuine,
  version-specific meta-line gap in ClickHouse's own streaming JSON formats,
  predating ClickHouse GitHub PR #74181, that affects the *current*
  production code identically, not an official-client defect — tracked as
  its own general compatibility bug, independent of this ADR, by #627), and
  net production-code deletion (mechanically estimated at -154 physical
  LOC). A 2026-08-07 decision-methodology amendment reclassified both as
  non-blocking and moved the decision to **"Accepted"**, authorizing a Phase 2
  implementation attempt. That attempt's plan review (5 rounds, 23 verified
  findings) surfaced an eleventh, disqualifying consideration Phase 0 never
  measured: `@clickhouse/client-web`'s abort/cancellation model ties the
  real network request exclusively to its own internal `AbortController`,
  never to the caller's own `AbortSignal` — structurally incompatible with
  the already-shipped Phase 1 transport contract's requirement that the
  caller's signal control cancellation for the whole response lifetime
  (including body streaming; breaks mid-stream Cancel for progressive
  queries/exports). Two independent architecture reviews (ChatGPT and a
  separate Fable/high reviewer) confirmed this and additionally found that,
  once every other required correction is applied (byte-exact SQL/auth
  restoration, a hand-written query-string serializer replacing the
  vendor's incompatible one), the official client contributes no bytes or
  behavior to the actual wire request. ADR-0005 reverted to **Rejected** the
  same day — see the ADR's "Phase 2 cancellation-incompatibility addendum"
  for the full mechanics. `src/net/ch-client.ts` (the current custom
  transport) **remains authoritative — no production code changed at any
  point across either amendment**. Phase 1 (separating application policy
  from the concrete transport implementation) — **landed** on
  `wip/585-phase1-transport-seam`: `src/net/clickhouse-transport.types.ts`
  (the `ClickHouseTransport` contract) + `src/net/clickhouse-http-transport.ts`
  (`createHttpTransport`, the current implementation behind it) put the
  existing transport behind a narrow seam with zero behavior change;
  `ch-client.ts` keeps every auth/epoch/retry policy and product operation —
  this remains valuable independent of the ADR's final decision. Phases 2-4
  (production official-client implementation, cutover, custom-transport
  deletion) **do not proceed without a new decision** — re-evaluation would
  need either an upstream client API returning the native
  `Response`/rejection while the caller's `AbortSignal` controls the real
  fetch, or a deliberate renegotiation of the transport contract's
  cancellation semantics themselves.

- **#630 — extract the SQL Browser's own Fetch-native transport mechanics
  into a first-party package.** Independent of the #585/ADR-0005 track above
  (ADR-0005 rejects the *third-party* `@clickhouse/client-web` client; #630
  extracts SQL Browser's *own* hand-rolled, already-proven-correct
  mechanics, and does not reopen or depend on ADR-0005's decision either
  way). Phase 1 (merged, PR #640) froze the current `createHttpTransport`'s
  native Fetch/Response/cancellation semantics as a real-browser
  characterization suite, with no production code change — the behavioral
  baseline Phase 2 is not allowed to alter. **Phase 2** moves `chUrl`/URL
  serialization and the low-level injected-`fetch()` request into a new
  `packages/clickhouse-http` — the repository's first npm workspace,
  private, zero runtime dependencies, zero bare-specifier imports of its
  own, exposing only its `.` export — and turns
  `src/net/clickhouse-http-transport.ts` into a temporary compatibility
  adapter whose `send()` delegates to the package's `request()`;
  `streamLines()` stayed local at that point, deferred to Phase 3.
  `ch-client.ts`'s composition graph, auth/epoch/retry policy, and eager
  pre-credential `chUrl` preflight are all unchanged. **Phase 3** (merged)
  moves the progress-bearing JSON-lines read loop (`streamLines`, plus the
  canonical `StreamLine`/`StreamCallbacks`/`ProgressMetaColumn` wire types)
  and the HTTP exception-text parser + byte-safe late-exception framer
  (`parseExceptionText`, `findExceptionFrame`/`ExceptionFrame` — now
  `Uint8Array`-in, no caller-side latin1 conversion) into the package too —
  a real move+delete, not an additive compatibility layer: the transport
  adapter and its type contract are now request/send-only, and
  `core/stream.ts` no longer declares a second copy of the wire type.
  `runQuery` (itself under `src/net/**`) calls the package's `streamLines`
  directly rather than through the transport seam, since there is exactly
  one production stream implementation now. SQL Browser keeps `StreamResult`,
  row caps, percentages, raw/result presentation, editor-caret positioning,
  and auth-expiry/denial UI policy exactly where they were —
  `applyStreamLine` now narrows an open `Record<string, unknown>` parsed
  record instead of re-declaring the package's wire type. **Phase 4** (merged)
  is purely additive: `ensureClickHouseSuccess` (non-consuming success
  classification — returns a successful `Response` by strict identity,
  never cloned/read; a non-2xx response reads its error text exactly once
  and throws a new minimal `ClickHouseError`), `consumeJsonResponse`/
  `consumeTextResponse`/`consumeProgressResponse` (`response.ts`, new),
  convenience `queryJson`/`queryText`/`queryProgress` client methods (each
  exactly one `request()` plus one matching consumer — one Fetch, no SQL
  Browser Table/KPI/TSV mode knowledge), and a stateless wire-level
  `killQuery` (`KILL QUERY WHERE query_id = <quoted> ASYNC` via one
  `queryText()` call; no credential lookup, refresh, epoch, retry, or query
  registry; a private, unexported `quoteKillQueryId` reproduces only
  `src/core/format.ts`'s backslash-then-quote string-literal escaping as a
  narrow Phase-4 stopgap, not general SQL quoting). Zero SQL Browser
  production files under `src/**` changed — root `queryJson`/`runQuery`/
  `exportQuery`/ordinary `killQuery`/`killQueryWithLease` all continue
  unchanged through `authedFetch`'s existing auth/epoch/retry policy; no
  `src/**` caller adopts the new package APIs yet. A new direct
  `client.queryProgress()` Chromium/WebKit scenario (added to the existing
  `tests/e2e/clickhouse-http-transport.{html,spec.js}` harness, alongside
  the unchanged Phase 1/3 scenarios) proves the identical native
  post-header-cancellation semantics through the new API. **Phase 5**
  (merged) moves SQL Browser's own ClickHouse SQL string-literal/identifier
  quoting (`sqlString`/`quoteIdent`/`qualifyIdent`) and its generic
  ClickHouse type-expression AST/parser/canonicalization/wrapper/enum
  grammar into the package too, along with the shared lexical scanner
  (`scanSpans`/`Span`/`SpanKind`) that grammar's dependency closure
  requires — a real move+delete, not an additive layer: `src/core/format.ts`
  no longer declares any quoting helper or forwarding alias, and
  `src/core/clickhouse-type.ts`/`sql-spans.ts`/`quoted-span.ts` are deleted
  outright. `packages/clickhouse-http/src/client.ts`'s `killQuery` now
  quotes through the package's own `sqlString`, retiring the Phase-4
  `quoteKillQueryId` stopgap. Every real production consumer is retargeted
  onto the package's public `.` export: `src/net/ch-client.ts`,
  `src/ui/app.ts`, `src/core/variable-options.ts`, `src/core/completions.ts`,
  `src/ui/schema.ts`, `src/ui/schema-detail.ts`, `src/ui/explain-graph.ts`,
  `src/core/param-type.ts`, `src/core/kpi.ts`,
  `src/core/dashboard-variables.ts`, and the scanner's other surviving
  consumers (`sql-lex.ts`, `sql-split.ts`, `param-scan.ts`,
  `type-display.ts`, `optional-blocks.ts`, `format.ts` itself).
  `isSupportedOptionScalar` (SQL Browser option/control policy over which
  scalar families are eligible for an option-backed control, not generic
  grammar) moved to `src/core/param-type.ts` instead — the package never
  exports it. SQL Browser's own display/FORMAT/parameter-control/KPI/
  Dashboard-variable/UI policy stays exactly where it was; only the
  underlying generic mechanics changed owner, and the existing parser/
  helper bodies moved rather than being redesigned. This required revising
  the architecture boundary itself (see below) since SQL Browser language
  consumers now legitimately import the package outside `src/net/**`.

  **Phase 6** (merged) composes SQL Browser authentication through one
  new module, `src/net/authenticated-clickhouse-request.ts` — a real
  move+delete of the normal-request auth/epoch/refresh/lifecycle policy
  that used to live in `ch-client.ts` as `authedFetch()`/a module-private
  `transportFor(ctx)`: both are gone, with no forwarding alias, no second
  retry loop, and no second Authorization constructor. The new module
  builds the package client directly
  (`createClickHouseHttpClient(...).request()`) rather than through the
  compatibility transport adapter, and exposes `authenticatedRequest()`
  (the moved trust-boundary loop) plus `authenticatedJson()`/
  `authenticatedText()`/`authenticatedProgress()`, each composing it with
  exactly one matching package response consumer. `ChCtx` now `extends`
  the new module's narrower `AuthenticatedRequestCtx` instead of
  redeclaring its fields, adding only `dataLakeCatalogSettingUnsupported`.
  `queryJson()` is the first real production consumer of the package's
  JSON response consumer, translating the package's `ClickHouseError`
  back to `queryJson`'s existing plain-`Error` compatibility shape (same
  parsed message); `runQuery()`/`exportQuery()` switch only their
  `authedFetch()` call to the new raw `authenticatedRequest()` entrypoint,
  keeping their own result/error/body handling unchanged.
  `killQueryWithLease()`'s frozen-lease bypass is untouched — it already
  built its own one-shot transport directly from the frozen lease, never
  through `ChCtx`, so it does not route through the new mutable-context
  auth loop. `build/check-boundaries.mjs`'s two existing #585
  transport-leaf forbidden lists and the #512 `connectionAuthorityFiles`
  lifecycle-authority list now name the new module too (a data extension
  of existing rules, not a new scanner); `ch-client.ts` stays in those
  lists through Phase 7. Real-browser coverage: authenticated-path
  variants of the existing post-header cancellation scenarios 5-9
  (`tests/e2e/clickhouse-http-transport.{html,spec.js}`), proving the
  identical native Fetch/Response/cancellation semantics survive being
  driven through a real, production-shaped `AuthenticatedRequestCtx`
  (synthetic test credentials, one deterministic epoch) in both Chromium
  and WebKit. **Phase 7** (below) completes the deferred work from here:
  `runQuery`/`exportQuery`'s cutover and their own result/export ownership
  migration, the remaining `killQuery`/`killQueryWithLease` transport
  migration, and deletion of the now-superseded transport-adapter
  compatibility seam.

  **Phase 7** (merged) migrates `src/application/query-execution-service.ts`
  and `export-service.ts` off the generic `runQuery`/`exportQuery` and the
  ordinary mutable-context `killQuery`, then deletes all three outright —
  no forwarding wrapper. QES is injected three narrow authenticated
  primitives (`runProgress`/`runText`/`cancel`) instead of a `ctx()`
  provider, and now OWNS the Table/KPI/TSV/explicit-raw format→settings
  mapping `runQuery` used to own. `runQuery` itself already computed a
  positive ordinary row limit's `max_result_rows`/
  `result_overflow_mode=break` cap independently of format and applied it
  uniformly on every branch; QES's rewrite preserves that exact behavior on
  ALL FOUR format branches and adds the per-branch regression coverage that
  behavior never previously had at this granularity, including a dedicated
  explicit-FORMAT-with-row-limit case — guarding against a future rewrite
  scoping the cap to only Table/KPI. `ExportService` is injected
  `exportResponse`/`runEffectText`/
  `cancel` the same way; pre-header failure classification moves from its
  own `resp.ok`/`resp.text()` check onto the package's
  `ensureClickHouseSuccess()`, reached through a new fourth
  `authenticated-clickhouse-request.ts` wrapper, `authenticatedResponse()`.
  `src/ui/app.ts` adds one shared `cancelOwnedQuery(ownerEpoch, queryId)`
  callback that QES's `kill()`, the workbench session's cancel, and both
  `ExportService` cancel paths all delegate to.
  `ConnectionSession.captureCancellationLease` widens to take an optional
  `expectedEpoch` parameter (default: the current epoch): a caller holding
  an older operation's owner epoch gets `null` once the session has moved
  to a replacement epoch, while a same-epoch refreshed credential still
  succeeds. `killQueryWithLease` is rewritten onto the package's own
  stateless `client.killQuery(...)` (dropping its `sqlString` argument —
  the package now owns that quoting) instead of the local transport
  adapter, preserving the exact same no-`ChCtx`/no-refresh/no-retry
  invariant Phase 6 established for this bypass. With every caller
  migrated, `src/net/clickhouse-http-transport.ts`/
  `clickhouse-transport.types.ts` (the local compatibility transport seam
  Phase 3 introduced) are deleted outright, along with
  `tests/unit/clickhouse-http-transport.test.ts` — there is now exactly
  one generic ClickHouse HTTP transport implementation in the repository,
  the package's.
  `build/check-boundaries.mjs`/`build/lib/check-legacy-owners.mjs` gain two
  new resurrection guards: a path-existence check on the two deleted
  transport files, and `findRetiredTopLevelApiViolations` — a real-parser
  check scoped to a module's own top-level statements (never descending
  into function/class/block bodies) — banning top-level `runQuery`/
  `exportQuery`/ordinary `killQuery` (and their types) from returning
  anywhere under `src/**`, without rejecting the legitimate surviving
  `client.killQuery(...)` member call inside `killQueryWithLease`.
  `tests/unit/clickhouse-http-package-policy.test.js`'s Phase 3
  former-owner registry (`PHASE3_LEGACY_OWNER_FILES`) stays unchanged as a
  historical record; its own file-read loop is replaced with explicit
  absence assertions for the two Phase 7 files plus a real scan of the
  surviving `src/core/stream.ts`. A new real-browser (Chromium and WebKit)
  e2e fixture, `tests/e2e/export-post-header-cancel.{html,spec.js}`, proves
  native post-header cancellation semantics through the actual export
  path, and `tests/spike/clickhouse-client/run-matrix.mjs`'s
  deletion-estimate classification is reconciled with the post-cutover
  tree (its spike consumers — `current-adapter.ts`/`official-adapter.ts`/
  `parity.test.ts`/`live-sessions.test.ts` — retargeted off the retired
  types onto the Phase 7 production seams, without otherwise redesigning
  the official-client spike). Claims **A14**/**A15**/**A16**; **A17**
  (standalone package build/pack/typecheck proof) and **A18** (final
  ownership cleanup, `@clickhouse/client-web`/vendor-spike-wiring removal,
  and the tested #639 extraction handoff) remain deferred to **Phase 8**.
  See [[Source-Map]] and [[Architecture]] for the file-level detail and
  `build/check-boundaries.mjs`'s Rules A–D plus the Phase 3/5/7 narrow
  legacy-owner rules for the mechanical boundary enforcement: package↔root-src
  ban, package zero-bare-specifier ban, root↔package-deep-import ban, the
  former transport/contract/`core/stream.ts` owners (Phase 3) and the
  former SQL-quoting owner `format.ts` plus the retired Phase-4 killQuery
  stopgap owner (Phase 5) all rejected from regaining any moved identifier,
  deleted implementation files (`clickhouse-type.ts`/`sql-spans.ts`/
  `quoted-span.ts`) mechanically required to stay absent, and the retired
  top-level `runQuery`/`exportQuery`/ordinary-`killQuery`
  declarations/deleted transport files (Phase 7) mechanically banned from
  returning. The bare-import boundary is no longer a blanket "`src/net/**`
  only" rule: transport/protocol package APIs (`createClickHouseHttpClient`,
  `chUrl`, `streamLines`, the response consumers, `ClickHouseError`) remain
  `src/net/**`-only, while the mechanically allowlisted pure-language exports
  (SQL quoting, the generic type grammar, the shared scanner) may be
  imported by their actual SQL Browser consumers outside `src/net/**` too —
  as a plain named import only; every other access form
  (default/namespace/side-effect/dynamic import, package re-export gateway)
  stays `src/net/**`-only regardless of name, a real-parser check
  (`build/lib/check-legacy-owners.mjs`) rather than a specifier-text regex,
  since a regex cannot tell which names a named import binds.

  **Phase 8** (final phase, merged) claims **A17**/**A18**, completing issue
  #630. `packages/clickhouse-http` becomes independently buildable/packable:
  package-local `esbuild` (unbundled browser-first ESM, `bundle: false`) and
  `tsc` (declaration-only emit) produce `dist/**`; the manifest's `main`/
  `types`/`exports["."]` all point at that built output, never source;
  `npm run build`/`build/bundle.sh`/`deploy/install.sh` all explicitly build
  the package first (`npm run build:clickhouse-http`) before the root
  application builder, so root esbuild's metafile resolves the workspace
  symlink to `packages/clickhouse-http/dist/*.js` — attributed to the
  `project` ownership bucket, never `external` — with no `packages/
  clickhouse-http/src/*.ts` input anywhere. Root `tsconfig.json`/Vitest
  coverage drop package source entirely; package-local `tsconfig.json`/
  `vitest.config.ts` (100/95/90/100 per file) own it instead, exercising the
  built public barrel via a relative import to `src/index.ts` (coverage
  attribution reasons — the isolated-package proof below is the real
  built-artifact proof). A new `test/isolated-package.mjs` (`npm run
  test:pack`) builds the package, runs a REAL `npm pack`, installs the
  tarball into a fixture OUTSIDE the repository, imports it as ESM, and
  compiles a TypeScript consumer against its declarations — proving neither
  runtime nor type resolution ever falls back into this repository's source.
  A new package-owned Chromium/WebKit regression suite
  (`packages/clickhouse-http/test/browser/**`) serves the package's own
  generated `dist/**` directly (`harness.html` imports `/dist/index.js`, no
  import map); its former root-suite home
  (`tests/e2e/clickhouse-http-transport.{html,spec.js}`) splits into that
  package suite plus a narrower root `tests/e2e/authenticated-clickhouse-
  request.{html,spec.js}` for SQL Browser's own authentication-policy
  variants (the package-owned `fault-server.mjs` fixture, moved from the
  spike, stays importable from both). The migration-only `ch-client.ts`
  forwarding aliases (`chUrl`/`parseExceptionText`/`findExceptionFrame`) are
  removed now that every spike consumer is gone; `export-service.ts` imports
  `findExceptionFrame` directly from the package under one narrow, named
  Rule-D exception (`PHASE8_NARROW_RULE_D_EXCEPTIONS`) rather than through
  that retired gateway. Five new/extended architecture guards
  (`build/check-boundaries.mjs`/`build/lib/check-legacy-owners.mjs`, all
  real-parser-backed, never a hand-rolled regex scanner): package
  containment broadens to the package's own `test/**`/`build.mjs`/
  `vitest.config.ts` (Guard 1); the relative-deep-import ban on the package
  widens from `src/**` to the whole package directory, catching a
  `dist/**` escape a source-only ban would have missed (Guard 2); root-wide
  (not just former-owner-scoped) declaration/re-export ownership for the
  historical `chUrl`/`createHttpTransport`/`ClickHouseTransport`/
  `TransportDeps`/`TransportRequest` transport surface, with an exemption for
  the sanctioned package import itself (Guard 3); the same root-wide
  ownership rule for the moved progress-stream/exception-parsing primitives
  (Guard 4); and the `@clickhouse/client-web` ban's former "future official
  transport file" allowlist is deleted outright, its scan widened to
  `src/**`/`packages/clickhouse-http/**` (excluding generated `dist/**`)/
  `tests/**`/`build/**`, plus structural manifest/lock/script/directory
  checks (Guard 5). The whole `@clickhouse/client-web` devDependency, its
  npm scripts, and the executable `tests/spike/clickhouse-client/**`
  directory (33 files by the plan's own count) are deleted per an exact
  file-by-file disposition table — most outright, `fault-server.mjs` moved
  (above), a handful ported into first-party regressions then deleted; the
  candidate-build-only `additionalNotices`/`--notices` plumbing in
  `build/build.mjs`/`build/size-report.mjs` goes with them.
  `docs/evidence/585/**` and ADR-0005's Rejected decision/historical content
  are untouched — only a narrow current-state addendum documents the
  executable retirement (`tests/unit/client-web-retirement-policy.test.js`
  replaces the former `client-web-spike-policy.test.js`, whose assertions
  described the now-retired opposite state). #639 begins with external
  repository creation/release and the SQL Browser consumer cutover, per the
  tested mechanical extraction handoff this phase adds,
  [`docs/clickhouse-http-repository-extraction.md`](../docs/clickhouse-http-repository-extraction.md).

Re-read GitHub before acting because issue state can change; a MERGED PR is
not proof its code is on `main` (see the reset above).

Canonical decision records: [`docs/ADR-0001-reactivity.md`](../docs/ADR-0001-reactivity.md),
[`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md),
[`docs/ADR-0005-clickhouse-web-client.md`](../docs/ADR-0005-clickhouse-web-client.md).
Historical roadmap context is summarized in [[Operations-Memory]].
