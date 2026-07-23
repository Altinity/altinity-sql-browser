# Deployment configuration

Google Sheets integration is enabled only when a valid configuration object is present.

```json
{
  "google_sheets": {
    "oauth_client_id": "...apps.googleusercontent.com",
    "binding_table": "asb.google_sheet_bindings",
    "refresh_log_table": "asb.google_sheet_refresh_log",
    "append_refresh": {
      "enabled": true,
      "min_clickhouse_version": "26.8"
    },
    "limits": {
      "max_rows_full_refresh": 100000,
      "max_rows_per_append_run": 250000,
      "max_managed_cells": 2000000,
      "max_serialized_bytes": 200000000,
      "google_request_target_bytes": 1000000,
      "commit_batch_rows": 20000
    }
  }
}
```

## Rules

- Absence of `google_sheets` hides all Google actions and preserves existing behavior.
- Parse ClickHouse table names strictly as qualified identifiers and quote database/table components independently.
- The SPA does not create, alter, or migrate configured tables.
- Validate binding and refresh-log table conformance before first use per connection and cache successful checks for the session.
- Host-specific configuration may override top-level configuration for configured alternate ClickHouse hosts.
- Manual or unlisted connections have no Google Sheets capability unless explicitly configured.
- Limits are deployment policy and must be enforced before or during transfer without silent truncation.

## Required ClickHouse privileges

Binding operations require the deployment-selected combination of `SELECT` and `INSERT` on configured tables. Query execution requires the ordinary privileges of the pinned saved query. No application-specific `CREATE`, `ALTER`, `UPDATE`, or `DELETE` privilege is required.

## Feature compatibility

Full refresh does not require the append minimum version. Append mode additionally requires the configured minimum version and successful runtime probes for the source table and persistent commit-position columns.
