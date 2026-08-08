# Contributor guide — altinity-sql-browser

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework; runtime deps are rare and deliberate (currently seven,
all bundled — see hard rule 4). Quality is held by tests.

## Hard rules

1. **Coverage gate is non-negotiable.** `npm test` must pass, and `tsc --noEmit`
   must pass (ADR-0002 — incremental strict TypeScript, dev-time only; wired
   into the `pretest` step). The suite enforces per-file coverage floors of
   **100/95/90/100** (statements/functions/branches/lines). Most
   pure/network/state/DOM and render modules maintain 100/100/100/100;
   `src/ui/app.ts` + `src/main.ts` are browser glue and integration-tested.
   Add tests in the
   same change as the code. The whole hand-written tree is strict TypeScript
   (ADR-0002 complete, #267) — new modules start as `.ts`.
2. **Keep the layers honest.** Pure logic goes in `src/core/` (no DOM, no
   globals). Workspace aggregates go in `src/workspace/`; Dashboard model,
   layout, and application code goes in `src/dashboard/`, with dependency
   direction `model/layouts <- application <- UI`. App-level coordination and
   sessions go in `src/application/` and must not import `src/ui/` or
   `src/editor/`. SQL Browser's network *integration and application
   policy* (OAuth, `ChCtx`, auth/epoch/retry, product operations) goes in
   `src/net/`, with the fetch seam *injected*, never imported. Reusable,
   product-agnostic ClickHouse HTTP/Fetch mechanics (URL serialization, the
   low-level request, the progress-stream wire shape and its reader/decoder
   loop, HTTP exception-text/late-exception byte framing, and — since #630
   Phase 5 — ClickHouse SQL string-literal/identifier quoting, the generic
   ClickHouse type-expression AST/parser/canonicalization/wrapper/enum
   grammar, and the shared lexical scanner that grammar depends on) live in
   the first-party workspace package `packages/clickhouse-http` (#630
   Phase 2; the progress-stream/exception primitives since Phase 3; since
   Phase 4 also non-consuming HTTP success/error classification, explicit
   JSON/text/progress consumers, a minimal `ClickHouseError`, and a
   stateless wire-level `killQuery`) instead. The package itself may depend
   on nothing under SQL Browser `src/**` and declares zero runtime
   dependencies, and every deep import into its `src/**` stays forbidden
   everywhere (mechanically enforced, `build/check-boundaries.mjs`) — only
   its public `.` export is consumable. Bare-specifier package access
   splits into two categories: TRANSPORT/PROTOCOL APIs
   (`createClickHouseHttpClient`, `chUrl`, `streamLines`, the response
   consumers, `ClickHouseError`) remain importable only under `src/net/**`,
   exactly as Phase 2 established, alongside OAuth/Basic credential
   acquisition, refresh, epochs, lifecycle callbacks, retries, and SQL
   Browser's own product operations/result modes; the Phase-4 consuming
   query APIs (`queryJson`/`queryText`/`queryProgress`) remain additive and
   not yet consumed by any `src/**` caller (that cutover is Phase 7). The
   name/shape check is value-import-only: `import type`/`export type` and
   individual `import { type X }` specifiers of a transport/protocol name
   are never flagged (erased before bundling, so they carry no runtime
   package access — the same rationale `build/lib/check-legacy-owners.mjs`
   documents), matching `docs/ARCHITECTURE.md`. Pure LANGUAGE APIs
   (`sqlString`/`quoteIdent`/`qualifyIdent`,
   `scanSpans`/`Span`/`SpanKind`, and the generic type-grammar exports —
   `parseClickHouseType`, `analyzeTypeModifiers`, `canonicalType`,
   `enumMembers`/`enumValues`, and the rest of the wrapper/structural-query
   set) may instead be imported directly by their real SQL Browser
   consumers outside `src/net/**` too (mechanically allowlisted by name,
   `build/check-boundaries.mjs`'s revised Rule D) — only as a plain named
   import; default/namespace/side-effect/dynamic imports and package
   re-export gateways stay `src/net/**`-only regardless of name.
   `isSupportedOptionScalar` (which scalar families are eligible for an
   option-backed control) is SQL Browser option/control POLICY, not generic
   grammar, and stays owned by `src/core/param-type.ts` — the package never
   exports it. DOM rendering goes in `src/ui/` as functions that take the
   `app` controller — except the editor, which lives in `src/editor/` behind the
   injected editor seams (#143/#212): only `main.js` imports concrete adapters,
   and everything else addresses `app.sqlEditor` or `app.specEditor` explicitly.
   SQL execution, schema insertion, export, and SQL formatting must never target
   whichever document happens to be visible. Side-effectful environment access
   (location, crypto, storage, fetch) is injected through `createApp(env)` so
   everything is testable. Saved-query Spec static validation comes from
   `schemas/query-spec-v1.schema.json` through the pure `core/spec-schema.js`
   service; app-owned feature validators extend that one service for
   result/context-dependent rules.
3. **No secrets in git.** `config.json` (rendered) is gitignored; only
   `deploy/config.json.example` is committed. Remember `config.json` is served
   to browsers: prefer a PKCE public client; if an IdP requires a
   `client_secret` there, lock the redirect URI and treat the file as public
   (see README "Configuring OAuth").
4. **The build is esbuild only; runtime deps are rare and deliberate.** Source
   files are the tested files; esbuild bundles `src/main.ts` → `dist/sql.html`.
   Source development requires Node.js 22 or newer; `.nvmrc` selects Node 22,
   `package.json` declares the minimum, and `.npmrc` makes unsupported installs
   fail clearly. `package-lock.json` is committed; use `npm ci` for a
   reproducible dependency graph in local, CI, and release builds, and update
   the lock only with an intentional dependency change.
   There are **seven** bundled runtime dependencies — **CodeMirror 6** (the SQL
   editor, saved-query Spec JSON editor, and read-only source viewer, behind
   injected seams — #21/#212/#213),
   **Chart.js** (the Chart result view) with **chartjs-adapter-date-fns** and
   **date-fns**
   (registers the date-math backend Chart.js's `time` scale needs for
   line/area charts over a time-role X column — #309; the pure axis/role
   decision of *whether* to use it stays in `core/chart-data.ts`, the adapter
   is a side-effect-only import next to `Chart` itself in `main.ts`),
   **@dagrejs/dagre** (the EXPLAIN pipeline-graph layout),
   **@preact/signals-core** (the reactivity primitive — see
   `docs/ADR-0001-reactivity.md`), and **marked** (the Markdown LEXER for
   #60/#315 reference-doc bodies — used strictly as a pure tokenizer in
   `core/doc-markdown.ts`, like the signals precedent it needs no seam;
   `marked.parse()`/HTML-string output and `innerHTML` are FORBIDDEN, except
   for `ui/dom.ts`'s `html` prop: that escape hatch accepts only trusted,
   code-owned static markup (never user, server, or Markdown content) — the
   token tree is projected into DOM by `ui/doc-markdown-view.ts` under the
   fail-closed policy: images/raw HTML/rejected links render as literal
   text; measured +44 KB raw / ~3% artifact delta) — all inlined into the
   artifact, so the page loads no runtime libraries from third-party CDNs.
   `packages/clickhouse-http` (#630 Phase 2, the repository's first npm
   workspace) is **project source, not an eighth bundled runtime
   dependency**: it is private, ships no `dependencies`, and esbuild bundles
   it exactly like hand-written `src/**` — `build/size-report-lib.mjs`
   attributes it to the `project` ownership bucket, not `external`. Adding
   *another* runtime dependency is a deliberate decision (it grows the
   single served file) — don't do it casually. When a feature needs a library,
   keep the testable logic pure in `src/core/` (chart axis/role/pivot math in
   `src/core/chart-data.js`; DOT→positions in `src/core/dot-layout.js`, both
   100%-covered) and make the library call an **injected seam** (`app.Chart` /
   `app.Dagre` / `env.Editor` / `env.SpecEditor` / `env.CodeViewer`, like the fetch/crypto seams)
   so the DOM wrapper stays fully tested rather than dropping below the coverage gate. (The CM6
   adapters are unit-tested against the real libraries under happy-dom.)
   Ajv and `ajv-formats` are **dev dependencies only**: they strictly compile
   the canonical Library/saved-query/Spec schema graph to deterministic,
   self-contained generated ESM. The production
   artifact ships the generated validator, never the general Ajv engine.
   `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` are
   **dev dependencies** on the same footing: no code from them ships, but
   `build/fonts.mjs` reads their latin-subset woff2 files and inlines them as
   base64 `@font-face` sources (~89 KB of woff2 for the pair, +19% gzip on the
   artifact). DESIGN.md names both faces, and before this they were referenced
   by name with no `@font-face` anywhere — so they rendered only for users who
   already had them installed. Font weight is a deliberate cost like any other:
   `FONT_BYTE_BUDGET` in `build/fonts.mjs` is asserted by
   `tests/unit/typography-contract.test.js`, so adding latin-ext or an italic cut
   has to be a reviewed edit rather than silent growth. That same test is the
   gate on the whole type system — every `font-size` in `src/styles.css` must
   resolve to a `--text-*` token, no two steps in a ramp may sit closer than 1px,
   token contrast must clear WCAG AA in both themes, and no class the UI renders
   may be left with no CSS rule at all (which is how a browser-default Arial
   confirmation dialog once shipped).
5. **No UI framework; signals for state, imperative adapters for islands.** State
   reactivity is `@preact/signals-core` (`signal`/`effect`/`computed`/`batch`),
   migrated slice-by-slice (ADR-0001). **No React/Preact/Solid** — a Preact spike
   on the schema panel (`spike/preact-schema`, ADR-0001 addendum) confirmed a
   component model removes the in-place-mutation pain but buys a second render
   paradigm the roadmap doesn't justify. The hard, third-party, or
   high-frequency-pointer surfaces (the editor, the EXPLAIN/schema graphs,
   Chart.js, result-grid resize/sort) stay **imperative behind an injected seam** —
   signals coordinate state, they don't own every mousemove. The editor is
   **CodeMirror 6** behind explicit injected SQL and Spec editor seams (#21/#212;
   the SQL completion source swaps to from-scope data in #84). When a *second* consumer of a
   complex UI pattern appears, extract a shared primitive (e.g. `EditorPort`,
   `GraphSurface`, a result-view registry, `Drawer`) rather than copy it — but
   don't build a primitive speculatively for a single caller.

## How to add a result view / panel / feature

Touch these in one change:
- the module under `src/core/` (pure logic) or `src/ui/` (render) ;
- its `tests/unit/<module>.test.js` to 100% ;
- if it changes the deployed surface, `deploy/http_handlers.xml` + README.

## Repo map

| Path | What |
|---|---|
| `src/core/*` | pure logic, 100% covered |
| `src/net/*` | OAuth + ClickHouse client, injected fetch |
| `packages/clickhouse-http/src/*` | first-party npm workspace (repo's first, #630 Phase 2) — `chUrl`/URL serialization, the low-level injected-`fetch()` request, the progress-stream read loop and HTTP exception parsing/framing (Phase 3), (Phase 4) non-consuming success/error classification (`ensureClickHouseSuccess`), JSON/text/progress consumers, a minimal `ClickHouseError`, convenience `queryJson`/`queryText`/`queryProgress` client methods, and a stateless wire-level `killQuery`, and (Phase 5) the ONE ClickHouse SQL-quoting implementation (`sqlString`/`quoteIdent`/`qualifyIdent`), the ONE generic type-expression grammar (`parseClickHouseType`/`analyzeTypeModifiers`/`canonicalType`/wrapper/enum helpers), and the shared lexical scanner (`scanSpans`) — behind a public `.` export only; transport/protocol APIs stay `src/net/**`-only, while the pure-language exports above may be imported directly by their real SQL Browser consumers anywhere outside `src/net/**` too (mechanically allowlisted, `build/check-boundaries.mjs` Rule D); no `src/**` caller consumes the Phase-4 consuming query APIs yet |
| `src/application/*` | app-level coordination, sessions, and pure projections; no UI/editor imports |
| `src/workspace/*` | pure stored-workspace aggregate, persistence contracts, and mutations |
| `src/dashboard/*` | Dashboard model, layouts, and application runtime; dependency direction is mechanically checked |
| `src/ui/*` | hyperscript, icons, render modules, controller |
| `src/editor/*` | injected SQL/Spec editor ports + CodeMirror adapters (#143/#21/#212) |
| `src/state.ts` | state model + pure ops (strict TS — ADR-0002 phase 2) |
| `src/main.ts` | bootstrap (OAuth callback, share-links) |
| `src/**/*.types.ts` | type-only seam contracts (ADR-0002 phase 0), co-located next to the `.js` file each describes (or, for a shape spanning several consumers like `src/env.types.ts`, at their shared directory); `tsc --noEmit` gate |
| `src/generated/json-schema.types.ts` | **generated** persisted-data types (`QuerySpecV1`/`SavedQueryV2`/`LibraryV2`/`PanelCfg`) emitted by `build/emit-schema-types.mjs` from the schema manifest — never hand-edit, never hand-duplicate these shapes; regenerate via `npm run generate:schemas` |
| `build/build.mjs` | esbuild → `dist/sql.html` |
| `deploy/*` | install/uninstall + `http_handlers.xml` |
| `tests/unit/*` | one spec per module (vitest + happy-dom) |

## Knowledge base (project wiki)

The distilled maintainer/agent knowledge base lives **in this repo**, at `.wiki/`
— start at `.wiki/Home.md`. It is versioned with the code: update the affected
wiki page(s) in the same change that stales them, the same way this file,
`docs/*`, and `CHANGELOG.md` get reconciled (see "Reconcile forward work after
a substantive change" below). It maps architecture, workflow, decisions,
deployment, and operational lessons back to their canonical sources (this
file, `docs/*`, issues). `.wiki/Maintaining-This-Wiki.md` explains how to use
and update it. The old GitHub project wiki remote
(`altinity-sql-browser.wiki.git`) is a **frozen archive** — do not clone or
push to it.

## Conventions

Pure-by-construction modules, injected side-effect seams, per-file coverage
thresholds, and a single ClickHouse-served artifact built by esbuild.

## Working discipline

- **Surface out-of-scope findings, don't bury them.** Spot a real bug, data
  inconsistency, deprecated API, or future footgun outside the current task →
  open an issue labeled `inbox` (file:line + why deferred) and tell the user.
  High signal only, not style nits.
- **Reconcile forward work after a substantive change.** A change to behavior,
  schema, or a settled decision can stale tracked work. In the same commit,
  reconcile what it reshaped: the roadmap meta-issue (currently #68) — re-check
  or re-scope the track it touches; the affected issue's body (Goal/Acceptance);
  the relevant ADR addendum and `CHANGELOG.md` `[Unreleased]`; and any issue it
  obsoletes (close via "Closes #N" in the PR). Flag it if the rework is large.
  (Trivial typo/comment changes exempt.)
- **Convert friction into memory.** If a task needed retried commits or hit an
  unexpected failure (test/env/scope surprise), save a memory so the next
  session doesn't repeat it.
- **Contracts specify final-state invariants.** Issue contracts state what
  must be true after an interaction settles — not frame-by-frame behavior
  during gestures/transitions — unless a user-visible bug forces otherwise.
  ADR-0004's retrospective: the frame-level focus contract in #487/#488, not
  the code, was the dominant cost driver.
- **Subagent fan-out is read-only unless the prompt says otherwise.** A
  forked or spawned agent inherits the *entire* parent conversation —
  including this file and any skill script being run — so without an
  explicit boundary it can conclude it's the one meant to finish the whole
  task: committing, pushing, opening a PR, editing `CHANGELOG.md`, or
  writing to the memory directory. When fanning out review/finder/analysis
  subagents mid-task, state the boundary in every prompt ("read-only: no
  Edit/Write, no git/gh mutating commands, no TaskCreate/TaskUpdate, no
  memory writes — return only \<schema\>"), and prefer a fresh,
  self-contained agent over `fork` when the parent context includes an
  in-progress mutating workflow — a fork inherits that context, a fresh
  agent doesn't. Diff the working tree, `git log`, and `gh pr list` after
  every batch regardless: an instruction in a prompt is not an enforced tool
  restriction.
