# Example Generators

This directory contains the maintenance scripts that regenerate the checked-in
example libraries in `examples/`.

## Scripts

- `build-ontime-charts.mjs` regenerates `ontime-charts.json`
- `build-system-explorer-charts.mjs` regenerates `system-explorer-charts.json`
- `build-iceberg-install.mjs` regenerates `iceberg-install.json`
- `build-iceberg-dashboards.mjs` regenerates `iceberg-catalog-dashboard.json`
  and `iceberg-dba-dashboard.json`
- `validate-library.mjs` is the shared validator used by the generators and
  tests before any generated Library JSON is written

## Notes

- These are build-time helpers, not app runtime code.
- The dashboard generators need a ClickHouse client connection that can read
  the referenced datasets so they can derive live schema keys.
- The install generator uses the local Iceberg templates in
  `examples/iceberg-templates/`.

