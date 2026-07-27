# Example Bundles and Generators

The checked-in JSON files under `examples/` are canonical **portable bundle**
documents. Query definitions use saved-query **Spec v1**, and every Dashboard
example includes an explicit **Dashboard document** with semantic tile order
and either `flow@1` or `grafana-grid@1` layout. Every grid layout carries a
complete `flow@1` fallback.

The three flagship, hand-authored dashboards — `clickhouse-operations.json`,
`shop-charts.json`, and `ontime-charts.json` — are on **portable bundle v2 /
Dashboard document v2** (#447/#459): there is no curated `filters` array.
Dashboard variables are inferred from the `{name:Type}` placeholders in the
tiled queries' own SQL, matched by exact name, so a variable applies to
exactly the tiles whose query declares it — adding, removing, or renaming a
placeholder is the only way to change a variable's assignment. The generated
Iceberg examples (`iceberg-catalog-dashboard.json`, `iceberg-dba-dashboard.json`,
and the drill-down template) still go through `buildDashboard()` and stay on
**v1** with a minimal curated `filters` array (one per SQL parameter, no
label/default/targets) until that generator itself becomes version-aware.

Legacy Library v1/v2 JSON remains importable for compatibility, but it is not an
authoring format for new or regenerated examples.

## Maintenance commands

- `node examples/mjs/normalize-examples.mjs --check` verifies that every
  checked-in example and the Iceberg drill-down template use the canonical
  envelope and explicit Dashboard model.
- `node examples/mjs/normalize-examples.mjs` migrates/normalizes existing
  checked-in artifacts without changing their SQL or panel schema keys.

## Generators

- `build-ontime-charts.mjs` refreshes the live panel schema keys in
  `ontime-charts.json` while preserving its authored grid, KPI configuration,
  tile order, and flow fallback. It does not touch Dashboard variables — those
  are inferred at runtime from the query placeholders it leaves untouched.
- `build-iceberg-install.mjs` regenerates `iceberg-install.json`.
- `build-iceberg-dashboards.mjs` regenerates
  `iceberg-catalog-dashboard.json` and `iceberg-dba-dashboard.json`.
- `example-bundle.mjs` owns the shared portable-bundle and Dashboard authoring
  helpers, including explicit grid sizing, filters/defaults/targets, and flow
  fallback generation.

The dashboard generators that derive live result schema keys require an
appropriately privileged ClickHouse client connection. The install generator
uses the templates in `examples/iceberg-templates/`.
