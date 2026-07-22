# ClickHouse Operations dashboard

[`examples/clickhouse-operations.json`](../examples/clickhouse-operations.json)
is an operator-first dashboard imported and curated from the ClickHouse
Operations bundle. Open it with **File ▾ → Open…** against a cluster where the
signed-in user can inspect the relevant `system` tables.

Its sixteen visible tiles follow an investigation path:

- overview: live KPIs, running queries, query rate, active connections;
- resources: CPU, memory, I/O utilization, network traffic;
- background work: merges, mutations, replication checks;
- investigation: errors, largest tables, query-hash metric, query details, and
  recent server logs.

The active time range defaults to `-1h` through `now`. `user`, `query_kind`,
`exception_code`, and `query_hash` are inferred searchable multiselects; their
consumers consistently use `Array(T)` parameters with `has(...)`. `metric` and
`is_initial_query` remain single-select controls, while time and log search are
scalar. The other downloaded operational queries remain untiled in the Library.

Typical grants include `SELECT` on `system.metric_log`,
`system.asynchronous_metric_log`, `system.query_log`, `system.part_log`,
`system.text_log`, `system.parts`, `system.merges`, `system.mutations`, and
replication-related system tables. Exact availability depends on server
version and deployment policy; missing grants fail individual tiles without
hiding the rest of the dashboard.
