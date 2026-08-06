# Bundle size report

Sizes for the self-contained `dist/sql.html` and its inlined parts.

| Artifact | Raw | gzip | Brotli |
|---|---|---|---|
| `dist/sql.html` | 2.0 MiB | 609.1 KiB | 515.4 KiB |
| JS bundle | 1.8 MiB | 496.6 KiB | 409.0 KiB |
| CSS (minified) | 231.4 KiB | 106.9 KiB | 103.2 KiB |

## Ownership (raw contributed output bytes)

| Owner | Bytes | % of JS output |
|---|---|---|
| project | 615.3 KiB | 33.7% |
| generated | 446.6 KiB | 24.5% |
| external | 763.4 KiB | 41.8% |

## External packages

| Package | Bytes | % of JS output |
|---|---|---|
| `chart.js` | 192.5 KiB | 10.5% |
| `@codemirror/view` | 181.9 KiB | 10.0% |
| `date-fns` | 46.9 KiB | 2.6% |
| `@codemirror/state` | 45.6 KiB | 2.5% |
| `marked` | 40.9 KiB | 2.2% |
| `@dagrejs/dagre` | 39.5 KiB | 2.2% |
| `@codemirror/lang-sql` | 31.4 KiB | 1.7% |
| `@codemirror/autocomplete` | 30.8 KiB | 1.7% |
| `@lezer/lr` | 25.9 KiB | 1.4% |
| `@codemirror/language` | 23.9 KiB | 1.3% |
| `@codemirror/commands` | 22.8 KiB | 1.3% |
| `@lezer/common` | 19.9 KiB | 1.1% |
| `@codemirror/search` | 18.0 KiB | 1.0% |
| `@lezer/xml` | 8.4 KiB | 0.5% |
| `@kurkle/color` | 7.4 KiB | 0.4% |
| `@lezer/highlight` | 7.0 KiB | 0.4% |
| `@codemirror/lang-xml` | 5.8 KiB | 0.3% |
| `@preact/signals-core` | 4.6 KiB | 0.3% |
| `@marijn/find-cluster-break` | 2.3 KiB | 0.1% |
| `style-mod` | 2.2 KiB | 0.1% |
| `chartjs-adapter-date-fns` | 1.6 KiB | 0.1% |
| `@lezer/json` | 1.6 KiB | 0.1% |
| `w3c-keyname` | 1.5 KiB | 0.1% |
| `crelt` | 611 B | 0.0% |
| `@codemirror/lang-json` | 274 B | 0.0% |

## Entry points / chunks

| Output | Entry point | Bytes |
|---|---|---|
| `main.js` | `src/main.ts` | 1.8 MiB |

## Top 30 modules by contributed output bytes

| Module | Owner | Bytes | % |
|---|---|---|---|
| `src/generated/json-schema-validators.js` | generated | 209.5 KiB | 11.5% |
| `src/generated/example-dashboards.ts` | generated | 183.3 KiB | 10.0% |
| `node_modules/@codemirror/view/dist/index.js` | external | 181.9 KiB | 10.0% |
| `node_modules/chart.js/dist/chart.js` | external | 161.6 KiB | 8.9% |
| `src/generated/json-schemas.js` | generated | 53.8 KiB | 2.9% |
| `node_modules/@codemirror/state/dist/index.js` | external | 45.6 KiB | 2.5% |
| `node_modules/marked/lib/marked.esm.js` | external | 40.9 KiB | 2.2% |
| `node_modules/@dagrejs/dagre/dist/dagre.esm.js` | external | 39.5 KiB | 2.2% |
| `node_modules/@codemirror/lang-sql/dist/index.js` | external | 31.4 KiB | 1.7% |
| `node_modules/chart.js/dist/chunks/helpers.dataset.js` | external | 30.9 KiB | 1.7% |
| `node_modules/@codemirror/autocomplete/dist/index.js` | external | 30.8 KiB | 1.7% |
| `src/ui/app.ts` | project | 27.6 KiB | 1.5% |
| `src/ui/dashboard.ts` | project | 26.6 KiB | 1.5% |
| `node_modules/@lezer/lr/dist/index.js` | external | 25.9 KiB | 1.4% |
| `node_modules/@codemirror/language/dist/index.js` | external | 23.9 KiB | 1.3% |
| `node_modules/@codemirror/commands/dist/index.js` | external | 22.8 KiB | 1.3% |
| `node_modules/@lezer/common/dist/index.js` | external | 19.9 KiB | 1.1% |
| `src/ui/results.ts` | project | 18.3 KiB | 1.0% |
| `node_modules/@codemirror/search/dist/index.js` | external | 18.0 KiB | 1.0% |
| `src/dashboard/application/dashboard-viewer-session.ts` | project | 14.9 KiB | 0.8% |
| `src/ui/dashboard-tree.ts` | project | 13.6 KiB | 0.7% |
| `src/ui/file-menu.ts` | project | 12.6 KiB | 0.7% |
| `src/core/chart-data.ts` | project | 11.7 KiB | 0.6% |
| `src/ui/explain-graph.ts` | project | 11.7 KiB | 0.6% |
| `src/state.ts` | project | 10.6 KiB | 0.6% |
| `src/ui/shortcuts.ts` | project | 10.1 KiB | 0.6% |
| `src/net/ch-client.ts` | project | 9.3 KiB | 0.5% |
| `src/dashboard/model/workspace-semantics.ts` | project | 8.5 KiB | 0.5% |
| `node_modules/@lezer/xml/dist/index.js` | external | 8.4 KiB | 0.5% |
| `src/core/spec-schema.ts` | project | 8.1 KiB | 0.4% |

> Percentages are of raw contributed output bytes (metafile bytesInOutput); gzip/Brotli are measured per whole artifact only — compression is not additive across modules.
