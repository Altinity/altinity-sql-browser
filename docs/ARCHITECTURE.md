# Architecture

## Layers

```
core/   pure logic         — strings/numbers/JWT/PKCE/SQL-tokenize/stream-parse
net/    integration        — OAuth (config+flow) and the ClickHouse® HTTP client
ui/     presentation       — hyperscript (h), icons, and render modules
state   model              — the state object and pure operations over it
main    bootstrap          — OAuth callback handling + initial render
```

The dependency direction is strictly downward: `ui` → `net`/`state`/`core`,
`net` → `core`, `core` → nothing. There are no cycles, so esbuild bundles
`main.js` into one IIFE.

## The injected-seam pattern

Every side effect is passed in, never imported directly by logic:

- `loadOAuthConfig(fetchFn, basePath)` and all of `net/` take `fetchFn`.
- `ch-client` functions take a `ctx = { fetch, origin, getToken, refresh,
  onSignedOut }`.
- `createApp(env)` injects `document`, `window`, `location`, `fetch`, `crypto`,
  `sessionStorage`.
- `generatePKCE(cryptoObj)`, `storage` helpers `(…, store)`, `timeAgo(ts, now)`
  all accept their dependency.

This is why the suite needs no network/DOM mocking libraries — plain stubs
suffice, and coverage is genuine.

## The controller (`ui/app.js`)

`createApp(env)` returns the `app` object that every render module receives:

- `app.state` — the state model
- `app.dom` — live references to mounted regions, repopulated by `renderApp`
- `app.actions` — callbacks (run, newTab, share, toggleSaved, loadColumns, …)
- `app.chCtx` — the ClickHouse fetch context
- persistence: `app.savePref(name, value)` (raw prefs), `app.saveJSON` (lists)

Render modules import nothing from `app.js` (avoiding a cycle); they take `app`
as a parameter.

## Query execution

`runQuery` (in `net/ch-client.js`) streams ClickHouse's
`JSONStringsEachRowWithProgress` format: each newline-delimited object is folded
into the result via the pure `applyStreamLine`. TSV/JSON output formats are
fetched as raw text. A single automatic token refresh fires on 401/403 or a
`token_verification_exception` body.

## Build

`build/build.mjs` runs esbuild (bundle + minify, IIFE) and inlines the script +
`styles.css` into `build/template.html`, producing `dist/sql.html`.
