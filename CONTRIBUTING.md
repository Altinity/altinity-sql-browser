# Contributing to the Altinity® SQL Browser

Thanks for your interest! This is a modular, no-framework ES-module SPA that
builds to **one self-contained HTML file** (`dist/sql.html`) served from a
ClickHouse® cluster. Quality is held by tests and a strict layering discipline —
please read the hard rules below before opening a PR.

## Quickstart

```bash
npm install
npm test            # vitest + coverage gate (must pass)
npm run build       # esbuild → dist/sql.html
npm run local       # build, then serve locally with a connection picker
npm run test:e2e    # Playwright (chromium + firefox); needs: npx playwright install chromium firefox
```

Requirements: Node 22, a POSIX shell. No other toolchain.

## Hard rules (non-negotiable)

These mirror `CLAUDE.md` (the in-repo agent guide) — the same rules apply to human
contributors.

1. **The coverage gate must pass.** `npm test` enforces **100% per-file** for the
   pure / network / state / DOM / render layers. `src/ui/app.js` + `src/main.js`
   are the browser glue, gated lower and integration-tested. **Add tests in the
   same change as the code.**
2. **Keep the layers honest.**
   - Pure logic → `src/core/` (no DOM, no globals).
   - Network → `src/net/` with the `fetch` seam **injected**, never imported.
   - DOM rendering → `src/ui/` as functions that take the `app` controller.
   - Side-effectful environment access (location, crypto, storage, fetch) is
     injected through `createApp(env)` so everything is testable under happy-dom.
3. **No secrets in git.** `config.json` (rendered) is gitignored; only
   `deploy/config.json.example` is committed. `config.json` is served to browsers
   — prefer a PKCE public client (see the README "Configuring OAuth" and
   `SECURITY.md`).
4. **The build is esbuild only; runtime deps are rare and deliberate.** There are
   exactly **two** bundled runtime dependencies — **Chart.js** and
   **@dagrejs/dagre** — both inlined so the page makes zero third-party requests.
   Adding another is a deliberate decision that grows the single served file. When
   a feature needs a library, keep the testable logic pure in `src/core/` and make
   the library call an **injected seam** (like `app.Chart` / `app.Dagre`).

## How to add a result view / panel / feature

Touch these in one change:
- the module under `src/core/` (pure logic) or `src/ui/` (render);
- its `tests/unit/<module>.test.js` to 100%;
- if it changes the deployed surface, `deploy/http_handlers.xml` + the README.

## Pull requests

- Branch off `main`; keep PRs focused.
- `npm test` green (coverage gate) and `npm run build` succeeds.
- Update the README / `CHANGELOG.md` (`[Unreleased]`) when behavior or the
  deployed surface changes.
- Releases are cut by pushing a `vX.Y.Z` tag (see `.github/workflows/release.yml`).

## Reporting bugs / security

Open a GitHub issue for bugs and feature requests. For security-sensitive
reports, follow `SECURITY.md` instead of filing a public issue.
