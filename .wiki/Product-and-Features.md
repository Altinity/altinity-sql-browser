# Product and features

Back to [[Home]]. Related: [[Architecture]], [[Deployment-and-Security]].

Altinity SQL Browser is a framework-free, OAuth-gated ClickHouse SPA delivered as
one self-contained HTML file.

## Major surfaces

| Surface | Primary implementation |
|---|---|
| SQL + saved-query Spec JSON editing | `src/editor/*`, `core/spec-draft.js`, `core/completions.js`, `core/from-scope.js` |
| Query/script execution and streaming | `ui/app.js`, `net/ch-client.js`, `core/stream.js`, `core/sql-split.js` |
| Schema browser and lineage graph | `ui/schema*.js`, `core/schema-graph.js`, `core/schema-cards.js` |
| Results table, sorting, cell detail | `ui/results.js`, `ui/grid-render.js`, `core/sort.js`, `core/cell.js` |
| Charts and panel registry | `core/chart-data.js`, `core/panel-cfg.js`, `ui/panels.js`, `ui/chart-render.js` |
| EXPLAIN pipeline/estimate views | `core/explain.js`, `core/dot*.js`, `ui/explain-graph.js` |
| Saved query library/import/export/share | `core/saved-io.js`, `core/share.js`, `ui/file-menu.js`, `ui/saved-history.js` |
| Dashboards, filters, typed parameters | `core/dashboard.js`, `core/param-*.js`, `core/optional-blocks.js`, `ui/dashboard.js` |
| OAuth and credential login | `net/oauth*.js`, `ui/login.js`, `core/pkce.js`, `core/auth-handoff.js` |

## Runtime libraries

CodeMirror 6, Chart.js, Dagre, and `@preact/signals-core` are bundled. Adding a
new runtime dependency is an architectural decision because it enlarges the one
served artifact and can break raw-ESM E2E harnesses.

The design/product source of truth is [`DESIGN.md`](../DESIGN.md) (design system,
tokens) and [`PRODUCT.md`](../PRODUCT.md) (positioning, users, purpose) at the repo
root. User documentation starts in [`README.md`](../README.md); demo libraries live in
[`examples/`](../examples/).
