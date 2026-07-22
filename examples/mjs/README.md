# Example Bundles and Generators

The checked-in JSON files under `examples/` are canonical **portable bundle
v1** documents. Query definitions use saved-query **Spec v1** and every
Dashboard example includes an explicit **Dashboard document v1** with semantic
tile order, filter definitions, and either `flow@1` or `grafana-grid@1` layout.
Every grid layout carries a complete `flow@1` fallback.

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
  `ontime-charts.json` while preserving its authored grid, filters, KPI
  configuration, tile order, and flow fallback.
- `build-iceberg-install.mjs` regenerates `iceberg-install.json`.
- `build-iceberg-dashboards.mjs` regenerates
  `iceberg-catalog-dashboard.json` and `iceberg-dba-dashboard.json`.
- `example-bundle.mjs` owns the shared portable-bundle and Dashboard authoring
  helpers, including explicit grid sizing, filters/defaults/targets, and flow
  fallback generation.

The dashboard generators that derive live result schema keys require an
appropriately privileged ClickHouse client connection. The install generator
uses the templates in `examples/iceberg-templates/`.
