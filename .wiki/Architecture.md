# Architecture

Back to [[Home]]. Related: [[Source-Map]], [[Decisions-and-Roadmap]].

## Dependency shape

```text
main.js (bootstrap + concrete adapters)
  ├─ ui/ (renderers and controller)
  ├─ editor/ (injected SQL + Spec CodeMirror adapters)
  ├─ net/ (OAuth and ClickHouse HTTP)
  ├─ state.js (signals-backed model and operations)
  └─ core/ (pure parsing, transforms, layout, formatting)

ui/ → net/state/core     net/ → core     core/ → nothing
```

`src/main.js` is the composition root. `createApp(env)` receives browser and
service dependencies. Render modules receive the returned `app` controller and
must not import `app.js`, which prevents cycles.

## Side-effect seams

- Network functions receive `fetch` or a ClickHouse context.
- PKCE, storage, time, location, and browser globals are parameters.
- CodeMirror is behind explicit injected `app.sqlEditor` and `app.specEditor`
  seams; only the composition root chooses the adapters. SQL actions always
  address the SQL adapter rather than the currently visible document.
- Chart.js and Dagre are concrete adapters injected as `app.Chart` / `app.Dagre`.
- Signals coordinate state. Imperative/high-frequency surfaces remain adapters.

This pattern keeps tests genuine: plain stubs replace dependencies without broad
module mocking.

## Query path

1. The editor/controller prepares SQL and typed parameters.
2. `src/net/ch-client.js` sends the HTTP request with injected auth/fetch context.
3. `JSONStringsEachRowWithProgress` is folded line by line by pure stream logic.
4. Results resolve through the panel registry to table, chart, logs, KPI, filter,
   text, or graph-oriented renderers.
5. One auth refresh is attempted for expired/denied tokens.

## Build shape

`build/build.mjs` bundles `src/main.js` with esbuild, minifies it, and inlines JS
and `src/styles.css` into `build/template.html`. Output is `dist/sql.html`, with
no third-party runtime requests.

Canonical source: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
[`CLAUDE.md`](../CLAUDE.md).
