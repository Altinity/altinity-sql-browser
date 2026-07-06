# System explorer demo — introspecting ClickHouse® itself

A ready-made **Library** of 14 queries against ClickHouse's own `system` database —
running queries, merges/mutations/replication health, storage, and historical
query/part/error activity — running on the OSS `github.demo` cluster. Ideas and
query shapes are adapted from Mikhail Filimonov's
[ClickHouse ops Grafana dashboard](https://gist.github.com/filimonov/271e5b27c085356c67db3c1bf2204506)
(68 panels covering `metric_log`, `asynchronous_metric_log`, `query_log`,
`query_views_log`, `part_log`, and `error_log`) — not ported 1:1 (no Grafana
template macros, no per-cluster time-series for every background-pool metric),
just enough to show the shape of "explore your own cluster" as a Library +
Dashboard, not a full monitoring reimplementation.

The six historical queries (#9–#14) share **one pair of query variables**,
`{from:String}`/`{to:String}` (parsed with `parseDateTimeBestEffort`), instead
of each hardcoding its own `now() - INTERVAL …` window. Same names everywhere
means the Dashboard's global filter bar (#149 D3) renders a single **From /
To** field pair that re-runs all six time-ranged tiles together when you type
a new range — one filter, six charts.

- **Live demo:** **https://github.demo.altinity.cloud/sql**
- **The library file:** [`examples/system-explorer-charts.json`](../examples/system-explorer-charts.json)
  ([raw download](https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/examples/system-explorer-charts.json))
- **Reproduce it:** [`examples/build-system-explorer-charts.mjs`](../examples/build-system-explorer-charts.mjs)
  regenerates the JSON (it derives each chart's schema key live via `DESCRIBE`-
  equivalent `FORMAT JSON`, with throwaway `--param_from`/`--param_to` values
  bound just so ClickHouse can resolve column types — the shipped SQL keeps
  the placeholders unbound for the browser to fill in).

## Load it (≈30 seconds)

1. Open **https://github.demo.altinity.cloud/sql** and sign in (**Continue with
   GitHub** via Auth0, or use the credentials box — see
   [LOGIN-SCREEN.md](LOGIN-SCREEN.md) for what each login path grants).
2. Download [`system-explorer-charts.json`](https://raw.githubusercontent.com/Altinity/altinity-sql-browser/main/examples/system-explorer-charts.json)
   (right-click → Save link as…).
3. In the header, click **File ▾ → Append…** and pick the file (Append merges
   into whatever's already in your Library, reporting `Added N`; use **Open…**
   instead if you'd rather replace the whole Library). Eight of the fourteen
   queries import already **favorited**.
4. Click **File ▾ → "Open as dashboard"** (or the Dashboard link in the
   sidebar). Two KPI-less tiles (#6–8, live snapshots) render immediately;
   the six time-ranged tiles (#9–13, minus the table-only #14) show an "Enter
   a value for: from, to" placeholder until you type a range into the
   dashboard's **From / To** filter fields — then all six re-run together.
   `parseDateTimeBestEffort` accepts most absolute formats; e.g. From
   `2026-07-01 00:00:00`, To `2026-07-05 00:00:00` (there's no relative
   `now`/`today` shorthand — type a real timestamp for "to" as well).

## What each query demonstrates

| # | Query | View | What it shows |
|---|-------|------|----------------|
| 1 | Currently running queries | Table | `system.processes` live snapshot — often empty; that's a real result |
| 2 | Merges in progress | Table | `system.merges` — background merge progress + size |
| 3 | Mutations in progress | Table | `system.mutations WHERE NOT is_done`, with failure reason |
| 4 | Replication status | Table | `system.replicas` — delay, queue depth, leadership |
| 5 | Stuck replication queue entries | Table | `system.replication_queue WHERE num_tries > 0` |
| 6 | Largest tables by disk usage | Bar (horizontal) | `system.parts` summed per table |
| 7 | Active parts by table | Bar (horizontal) | part *count* per table — an early "too many parts" signal |
| 8 | Cumulative error counters | Bar (horizontal) | `system.errors` — every error code hit since restart |
| 9 | Queries per minute | Line | `system.query_log` bucketed per minute over `{from}`/`{to}`; `DateTime` axis auto-detected as time |
| 10 | Slowest query patterns — avg duration | Bar (horizontal) | `query_log` over `{from}`/`{to}`, grouped by `normalized_query_hash`, a non-count measure |
| 11 | Query errors over time | Grouped bars | `query_log` failures over `{from}`/`{to}`, **Series** = error name |
| 12 | Part lifecycle events over time | Grouped bars | `part_log` over `{from}`/`{to}`, **Series** = `event_type` (an `Enum8` column) |
| 13 | Memory usage over time | Line | `system.metric_log`'s `CurrentMetric_MemoryTracking` over `{from}`/`{to}`, averaged per minute |
| 14 | Query cost breakdown — slowest patterns (detail) | Table | the deep-dive version of #10 over `{from}`/`{to}`: executions, rows/bytes read, p99 memory |

Rows 1–5 and 14 need `SELECT` on the relevant `system.*` table; rows 6–13 also
read `system.query_log`/`system.part_log`/`system.metric_log`, which most
demo/read-only users won't have — sign in with an account that has broader
`system` grants (or run it against your own cluster as an admin) to see all
fourteen populate.

## Direct links

Every chartable query is also reachable as a single shareable link — open one
and the SQL **and** its chart configuration are pre-loaded. Rows 6–8 need only
**Run**, then the **Chart** tab; rows 9–13 also need `from`/`to` values typed
into the variable strip below the editor before Run is enabled (the link
itself can't carry a variable *value*, only the query).

- **Bar** — [Largest tables by disk usage](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIGNvbmNhdChkYXRhYmFzZSwgJy4nLCB0YWJsZSkgQVMgdGFibGUsIHN1bShieXRlc19vbl9kaXNrKSBBUyBkaXNrX2J5dGVzXG5GUk9NIHN5c3RlbS5wYXJ0c1xuV0hFUkUgYWN0aXZlXG5HUk9VUCBCWSBkYXRhYmFzZSwgdGFibGVcbk9SREVSIEJZIGRpc2tfYnl0ZXMgREVTQ1xuTElNSVQgMTUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImhiYXIiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6InRhYmxlOlN0cmluZ3xkaXNrX2J5dGVzOlVJbnQ2NCJ9fQ==)
- **Bar** — [Active parts by table](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIGNvbmNhdChkYXRhYmFzZSwgJy4nLCB0YWJsZSkgQVMgdGFibGUsIGNvdW50KCkgQVMgcGFydHNcbkZST00gc3lzdGVtLnBhcnRzXG5XSEVSRSBhY3RpdmVcbkdST1VQIEJZIGRhdGFiYXNlLCB0YWJsZVxuT1JERVIgQlkgcGFydHMgREVTQ1xuTElNSVQgMTUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImhiYXIiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6InRhYmxlOlN0cmluZ3xwYXJ0czpVSW50NjQifX0=)
- **Bar** — [Cumulative error counters](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIG5hbWUsIHZhbHVlIEFTIHRpbWVzXG5GUk9NIHN5c3RlbS5lcnJvcnNcbldIRVJFIHZhbHVlID4gMFxuT1JERVIgQlkgdmFsdWUgREVTQ1xuTElNSVQgMTUiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImhiYXIiLCJ4IjowLCJ5IjpbMV0sInNlcmllcyI6bnVsbH0sImtleSI6Im5hbWU6U3RyaW5nfHRpbWVzOlVJbnQ2NCJ9fQ==)
- **Line** — [Queries per minute](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIHRvU3RhcnRPZk1pbnV0ZShldmVudF90aW1lKSBBUyB0LCBjb3VudCgpIEFTIHF1ZXJpZXNcbkZST00gc3lzdGVtLnF1ZXJ5X2xvZ1xuV0hFUkUgZXZlbnRfdGltZSBCRVRXRUVOIHBhcnNlRGF0ZVRpbWVCZXN0RWZmb3J0KHtmcm9tOlN0cmluZ30pIEFORCBwYXJzZURhdGVUaW1lQmVzdEVmZm9ydCh7dG86U3RyaW5nfSkgQU5EIHR5cGUgPSAnUXVlcnlGaW5pc2gnXG5HUk9VUCBCWSB0XG5PUkRFUiBCWSB0IiwiY2hhcnQiOnsiY2ZnIjp7InR5cGUiOiJsaW5lIiwieCI6MCwieSI6WzFdLCJzZXJpZXMiOm51bGx9LCJrZXkiOiJ0OkRhdGVUaW1lfHF1ZXJpZXM6VUludDY0In19)
- **Bar** — [Slowest query patterns — avg duration](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIGxlZnQoYW55KHF1ZXJ5KSwgNTApIEFTIHF1ZXJ5LCBhdmcocXVlcnlfZHVyYXRpb25fbXMpIEFTIGF2Z19kdXJhdGlvbl9tc1xuRlJPTSBzeXN0ZW0ucXVlcnlfbG9nXG5XSEVSRSBldmVudF90aW1lIEJFVFdFRU4gcGFyc2VEYXRlVGltZUJlc3RFZmZvcnQoe2Zyb206U3RyaW5nfSkgQU5EIHBhcnNlRGF0ZVRpbWVCZXN0RWZmb3J0KHt0bzpTdHJpbmd9KSBBTkQgdHlwZSA9ICdRdWVyeUZpbmlzaCdcbkdST1VQIEJZIG5vcm1hbGl6ZWRfcXVlcnlfaGFzaFxuT1JERVIgQlkgYXZnX2R1cmF0aW9uX21zIERFU0NcbkxJTUlUIDE1IiwiY2hhcnQiOnsiY2ZnIjp7InR5cGUiOiJoYmFyIiwieCI6MCwieSI6WzFdLCJzZXJpZXMiOm51bGx9LCJrZXkiOiJxdWVyeTpTdHJpbmd8YXZnX2R1cmF0aW9uX21zOkZsb2F0NjQifX0=)
- **Grouped bars** — [Query errors over time](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIHRvU3RhcnRPZkhvdXIoZXZlbnRfdGltZSkgQVMgdCwgZXJyb3JDb2RlVG9OYW1lKGV4Y2VwdGlvbl9jb2RlKSBBUyBlcnJvciwgY291bnQoKSBBUyBuXG5GUk9NIHN5c3RlbS5xdWVyeV9sb2dcbldIRVJFIGV2ZW50X3RpbWUgQkVUV0VFTiBwYXJzZURhdGVUaW1lQmVzdEVmZm9ydCh7ZnJvbTpTdHJpbmd9KSBBTkQgcGFyc2VEYXRlVGltZUJlc3RFZmZvcnQoe3RvOlN0cmluZ30pIEFORCBleGNlcHRpb25fY29kZSAhPSAwXG5HUk9VUCBCWSB0LCBlcnJvclxuT1JERVIgQlkgdCIsImNoYXJ0Ijp7ImNmZyI6eyJ0eXBlIjoiYmFyIiwieCI6MCwieSI6WzJdLCJzZXJpZXMiOjF9LCJrZXkiOiJ0OkRhdGVUaW1lfGVycm9yOkxvd0NhcmRpbmFsaXR5KFN0cmluZyl8bjpVSW50NjQifX0=)
- **Grouped bars** — [Part lifecycle events over time](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIHRvU3RhcnRPZkhvdXIoZXZlbnRfdGltZSkgQVMgdCwgZXZlbnRfdHlwZSwgY291bnQoKSBBUyBuXG5GUk9NIHN5c3RlbS5wYXJ0X2xvZ1xuV0hFUkUgZXZlbnRfdGltZSBCRVRXRUVOIHBhcnNlRGF0ZVRpbWVCZXN0RWZmb3J0KHtmcm9tOlN0cmluZ30pIEFORCBwYXJzZURhdGVUaW1lQmVzdEVmZm9ydCh7dG86U3RyaW5nfSlcbkdST1VQIEJZIHQsIGV2ZW50X3R5cGVcbk9SREVSIEJZIHQiLCJjaGFydCI6eyJjZmciOnsidHlwZSI6ImJhciIsIngiOjAsInkiOlsyXSwic2VyaWVzIjoxfSwia2V5IjoidDpEYXRlVGltZXxldmVudF90eXBlOkVudW04KCdOZXdQYXJ0JyA9IDEsICdNZXJnZVBhcnRzJyA9IDIsICdEb3dubG9hZFBhcnQnID0gMywgJ1JlbW92ZVBhcnQnID0gNCwgJ011dGF0ZVBhcnQnID0gNSwgJ01vdmVQYXJ0JyA9IDYsICdNZXJnZVBhcnRzU3RhcnQnID0gNywgJ011dGF0ZVBhcnRTdGFydCcgPSA4KXxuOlVJbnQ2NCJ9fQ==)
- **Line** — [Memory usage over time](https://github.demo.altinity.cloud/sql#eyJfX2FzYiI6MSwic3FsIjoiU0VMRUNUIHRvU3RhcnRPZk1pbnV0ZShldmVudF90aW1lKSBBUyB0LCBhdmcoQ3VycmVudE1ldHJpY19NZW1vcnlUcmFja2luZykgQVMgbWVtb3J5X2J5dGVzXG5GUk9NIHN5c3RlbS5tZXRyaWNfbG9nXG5XSEVSRSBldmVudF90aW1lIEJFVFdFRU4gcGFyc2VEYXRlVGltZUJlc3RFZmZvcnQoe2Zyb206U3RyaW5nfSkgQU5EIHBhcnNlRGF0ZVRpbWVCZXN0RWZmb3J0KHt0bzpTdHJpbmd9KVxuR1JPVVAgQlkgdFxuT1JERVIgQlkgdCIsImNoYXJ0Ijp7ImNmZyI6eyJ0eXBlIjoibGluZSIsIngiOjAsInkiOlsxXSwic2VyaWVzIjpudWxsfSwia2V5IjoidDpEYXRlVGltZXxtZW1vcnlfYnl0ZXM6RmxvYXQ2NCJ9fQ==)
