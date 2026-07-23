# Contributor guide — altinity-sql-browser

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework; runtime deps are rare and deliberate (currently seven,
all bundled — see hard rule 4). Quality is held by tests.

## Hard rules

1. **Coverage gate is non-negotiable.** `npm test` must pass, and `tsc --noEmit`
   must pass (ADR-0002 — incremental strict TypeScript, dev-time only; wired
   into the `pretest` step). The pure/network/state/DOM and render layers are
   gated at **100/100/100/100 per file**. `src/ui/app.ts` + `src/main.ts` are
   the browser glue — gated lower and integration-tested. Add tests in the
   same change as the code. The whole hand-written tree is strict TypeScript
   (ADR-0002 complete, #267) — new modules start as `.ts`.
2. **Keep the layers honest.** Pure logic goes in `src/core/` (no DOM, no
   globals). Network goes in `src/net/` with the fetch seam *injected*, never
   imported. DOM rendering goes in `src/ui/` as functions that take the `app`
   controller — except the editor, which lives in `src/editor/` behind the
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
   `marked.parse()`/HTML-string output and `innerHTML` are FORBIDDEN — the
   token tree is projected into DOM by `ui/doc-markdown-view.ts` under the
   fail-closed policy: images/raw HTML/rejected links render as literal
   text; measured +44 KB raw / ~3% artifact delta) — all inlined into the
   artifact, so the page loads no runtime libraries from third-party CDNs.
   Adding *another* runtime dependency is a deliberate decision (it grows the
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

The distilled maintainer/agent knowledge base is the **GitHub project wiki**, not a
directory in this repo. Clone it alongside the code and start at `Home.md`:

```sh
git clone https://github.com/Altinity/altinity-sql-browser.wiki.git .wiki   # branch: master
```

`.wiki/` is gitignored here (separate `repo.wiki.git`); push wiki edits to that
remote, never into this repo. It maps architecture, workflow, decisions, deployment,
and operational lessons back to their canonical sources (this file, `docs/*`, issues).
`.wiki/Maintaining-This-Wiki.md` explains how to use and update it.

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
