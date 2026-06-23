# Contributor guide — altinity-sql-browser

A modular ES-module SPA that builds to one self-contained HTML file served from
ClickHouse. No framework, no runtime deps. Quality is held by tests.

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
   The **one** bundled runtime dependency is **Chart.js** (the Chart result
   view) — inlined into the artifact, so the page still makes zero third-party
   requests. Adding *another* runtime dependency is a deliberate decision (it
   grows the single served file) — don't do it casually. When a feature needs a
   library, keep the testable logic pure in `src/core/` (chart axis/role/pivot
   math lives in `src/core/chart-data.js`, 100%-covered) and make the library
   call an **injected seam** (`app.Chart`, like the fetch/crypto seams) so the
   DOM wrapper stays fully tested rather than dropping below the coverage gate.

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
