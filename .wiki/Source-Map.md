# Source map

Back to [[Home]]. Related: [[Architecture]], [[Product-and-Features]].

## Code entry points

| Path | Role |
|---|---|
| `src/main.js` | browser bootstrap and concrete adapter injection |
| `src/ui/app.js` | controller, actions, orchestration, render entry |
| `src/state.js` | signals-backed state model and persistence operations |
| `src/net/ch-client.js` | ClickHouse HTTP execution and schema calls |
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
