# Contributor guide — altinity-sql-browser

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework; runtime deps are rare and deliberate (currently three,
all bundled — see hard rule 4). Quality is held by tests.

## Hard rules

1. **Coverage gate is non-negotiable.** `npm test` must pass. The pure/network/
   state/DOM and render layers are gated at **100/100/100/100 per file**.
   `src/ui/app.js` + `src/main.js` are the browser glue — gated lower and
   integration-tested. Add tests in the same change as the code.
2. **Keep the layers honest.** Pure logic goes in `src/core/` (no DOM, no
   globals). Network goes in `src/net/` with the fetch seam *injected*, never
   imported. DOM rendering goes in `src/ui/` as functions that take the `app`
   controller. Side-effectful environment access (location, crypto, storage,
   fetch) is injected through `createApp(env)` so everything is testable.
3. **No secrets in git.** `config.json` (rendered) is gitignored; only
   `deploy/config.json.example` is committed. Remember `config.json` is served
   to browsers: prefer a PKCE public client; if an IdP requires a
   `client_secret` there, lock the redirect URI and treat the file as public
   (see README "Configuring OAuth").
4. **The build is esbuild only; runtime deps are rare and deliberate.** Source
   files are the tested files; esbuild bundles `src/main.js` → `dist/sql.html`.
   There are **three** bundled runtime dependencies — **Chart.js** (the Chart
   result view), **@dagrejs/dagre** (the EXPLAIN pipeline-graph layout), and
   **@preact/signals-core** (the reactivity primitive — see
   `docs/ADR-0001-reactivity.md`) — all inlined into the artifact, so the page
   still makes zero third-party requests.
   Adding *another* runtime dependency is a deliberate decision (it grows the
   single served file) — don't do it casually. When a feature needs a library,
   keep the testable logic pure in `src/core/` (chart axis/role/pivot math in
   `src/core/chart-data.js`; DOT→positions in `src/core/dot-layout.js`, both
   100%-covered) and make the library call an **injected seam** (`app.Chart` /
   `app.Dagre`, like the fetch/crypto seams) so the DOM wrapper stays fully tested
   rather than dropping below the coverage gate.
5. **No UI framework; signals for state, imperative adapters for islands.** State
   reactivity is `@preact/signals-core` (`signal`/`effect`/`computed`/`batch`),
   migrated slice-by-slice (ADR-0001). **No React/Preact/Solid** — a Preact spike
   on the schema panel (`spike/preact-schema`, ADR-0001 addendum) confirmed a
   component model removes the in-place-mutation pain but buys a second render
   paradigm the roadmap doesn't justify. The hard, third-party, or
   high-frequency-pointer surfaces (the editor, the EXPLAIN/schema graphs,
   Chart.js, result-grid resize/sort) stay **imperative behind an injected seam** —
   signals coordinate state, they don't own every mousemove. CodeMirror 6 is the
   pre-approved next runtime dep, behind an `EditorPort` seam, to land when
   schema-aware autocomplete (#84) does (#21). When a *second* consumer of a
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
| `src/state.js` | state model + pure ops |
| `src/main.js` | bootstrap (OAuth callback, share-links) |
| `build/build.mjs` | esbuild → `dist/sql.html` |
| `deploy/*` | install/uninstall + `http_handlers.xml` |
| `tests/unit/*` | one spec per module (vitest + happy-dom) |

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
