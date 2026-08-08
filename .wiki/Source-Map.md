# Source map

Back to [[Home]]. Related: [[Architecture]], [[Product-and-Features]].

## Code entry points

| Path | Role |
|---|---|
| `src/main.js` | browser bootstrap and concrete adapter injection |
| `src/ui/app.js` | controller, actions, orchestration, render entry (composition root; shrunk by #588 — see below) |
| `src/application/workspace-session.js` | workspace write queue, cross-tab BroadcastChannel sync, refresh scheduling, `beforeunload` guard (#588) |
| `src/application/surface-navigation.js` | `/sql` routing, main-surface (Query↔Dashboard) navigation (#588) |
| `src/ui/workbench/variable-strip.js` | Workbench variable strip render + run-button sync (#588) |
| `src/ui/workbench/save-controller.js` | saved-query save/conflict/reload cluster (#588) |
| `src/ui/keyboard-owner.js` | shared keyboard-owner acquire/release channel (#588) |
| `src/dashboard/application/dashboard-repaint-plan.js` | pure repaint-decision arbitration extracted from `ui/dashboard.js`'s `renderDashboard` effect (#589) |
| `src/ui/dashboard-tile-gestures.js` | Dashboard corner-drag resize, Command/Ctrl-drag reorder, and modifier-cue controller, extracted from `ui/dashboard.js` behind an injected `TileGestureDeps` seam (#589) |
| `src/state.js` | signals-backed state model and persistence operations |
| `src/net/ch-client.js` | ClickHouse HTTP execution and schema calls; auth/epoch/retry policy, product operations, `ChCtx` (#585 Phase 1: generic request/stream mechanics delegate through the transport seam below; #630 Phase 2: `chUrl` re-exported from `@altinity/clickhouse-http`; #630 Phase 3: `streamLines` called directly, `parseExceptionText`/`findExceptionFrame`/`StreamLine`/`StreamCallbacks` re-exported; #630 Phase 4: unaffected — the package's new consuming query APIs/`killQuery` are additive and not yet consumed here; #630 Phase 5: `sqlString` also imported directly from the package, replacing the retired `../core/format.js` import) |
| `src/net/clickhouse-transport.types.js` | Type-only `ClickHouseTransport` contract — `send()` ONLY since #630 Phase 3 (`streamLines`/`StreamCallbacks` moved to the package); `TransportDeps`/`TransportRequest` alias the package's own types (#585 Phase 1; #630 Phase 2) |
| `src/net/clickhouse-http-transport.js` | `createHttpTransport` — temporary compatibility adapter, REQUEST/SEND-ONLY since #630 Phase 3: `send()` delegates to `@altinity/clickhouse-http`'s `request()`; no stream member at all (`ch-client.ts`'s `runQuery` calls the package's `streamLines` directly instead) (#585 Phase 1; #630 Phases 2-3) |
| `packages/clickhouse-http/src/` | First-party npm workspace package (repo's first) — `url.ts` (`chUrl`, the ONE URL-serializer implementation), `client.ts` (`createClickHouseHttpClient`, the low-level request/Fetch invocation, plus #630 Phase 4's `queryJson`/`queryText`/`queryProgress` convenience methods and stateless `killQuery` — since #630 Phase 5, `killQuery` quotes through this package's own `sql-quote.ts` `sqlString`, and the Phase-4 private `quoteKillQueryId` stopgap is gone), `progress-stream.ts` (`streamLines`, the ONE progress-bearing JSON-lines read loop, plus the canonical `StreamLine`/`StreamCallbacks`/`ProgressMetaColumn` wire types), `exceptions.ts` (`parseExceptionText`, `findExceptionFrame`/`ExceptionFrame` — byte-oriented, no caller-side latin1 conversion — plus #630 Phase 4's minimal `ClickHouseError`), `response.ts` (#630 Phase 4, new — `ensureClickHouseSuccess`, `consumeJsonResponse`/`consumeTextResponse`/`consumeProgressResponse`), and — new in #630 Phase 5 — `sql-quote.ts` (`sqlString`/`quoteIdent`/`qualifyIdent`, the ONE ClickHouse SQL-quoting implementation, moved verbatim from `src/core/format.ts`), `clickhouse-type.ts` (`parseClickHouseType`/`analyzeTypeModifiers`/`canonicalType`/the wrapper+enum helpers, the ONE generic type-expression grammar, moved verbatim from `src/core/clickhouse-type.ts` minus SQL Browser's `isSupportedOptionScalar` policy, which stayed at `src/core/param-type.ts`), `sql-spans.ts` (`scanSpans`/`Span`/`SpanKind`, the ONE shared lexical scanner, re-exported because surviving SQL Browser SQL-analysis modules still need it, moved verbatim from `src/core/sql-spans.ts`), and package-private `quoted-span.ts` (`scanDelimited`, moved verbatim from `src/core/quoted-span.ts`, not re-exported) — public export only, zero runtime dependencies, zero bare-specifier imports, no SQL Browser `src/**` dependency (#630 Phase 2; progress-stream/exceptions since Phase 3; response/query/kill APIs since Phase 4 — additive, not yet consumed by any `src/**` caller; SQL quoting/type grammar/scanner since Phase 5 — real production consumers retargeted). Bare package access is now two categories: transport/protocol APIs stay `src/net/**`-only; the pure-language exports above (quoting, type grammar, scanner) may be imported by their real SQL Browser consumers anywhere outside `src/net/**` too (mechanically allowlisted, `build/check-boundaries.mjs` Rule D) |
| `src/net/oauth.js` | OAuth flow/token exchange |
| `src/editor/editor-port.js` | SQL editor contract and safe no-op port |
| `src/editor/codemirror-adapter.js` | SQL CodeMirror 6 adapter |
| `src/editor/spec-editor.js` | saved-query Spec JSON CodeMirror 6 adapter |
| `src/core/spec-draft.js` | pure Spec parsing, validation registry, normalization, and formatting |
| `src/core/` | pure SQL, parameter, chart, graph, export, and formatting logic |
| `src/ui/` | DOM renderers and imperative UI adapters |
| `tests/unit/` | matching happy-dom/Vitest module tests |
| `tests/e2e/` | raw-ESM Playwright harnesses |
| `build/build.mjs` | esbuild + inline single-file build |
| `deploy/` | ClickHouse handler and installer assets |

## Documentation entry points

- [`README.md`](../README.md) — product behavior, local use, install, testing.
- [`CLAUDE.md`](../CLAUDE.md) — contributor source of truth.
- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) — dependency/seam overview.
- [`docs/ADR-0001-reactivity.md`](../docs/ADR-0001-reactivity.md) — signals and UI decisions.
- [`docs/ADR-0002-static-typing.md`](../docs/ADR-0002-static-typing.md) — incremental strict TypeScript.
- [`docs/ADR-0003-dashboard-viewing.md`](../docs/ADR-0003-dashboard-viewing.md) — dashboard viewing model.
- [`docs/ADR-0004-ui-shell.md`](../docs/ADR-0004-ui-shell.md) — the #577 Preact evaluation and its RETAIN-vanilla outcome.
- [`docs/V2-UX-HANDOVER.md`](../docs/V2-UX-HANDOVER.md) — shipped-UX + committed-contract inventory for the V2 redesign (#582).
- [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md) — deployment sequence.
- [`docs/LOGIN-SCREEN.md`](../docs/LOGIN-SCREEN.md) — login configuration.
- [`CHANGELOG.md`](../CHANGELOG.md) — released and unreleased behavior.
- [`docs/ui-snapshots/CAPTURE-SPEC.md`](../docs/ui-snapshots/CAPTURE-SPEC.md) — visual baseline.
