# Iceberg Catalog Explorer — installer + dashboards

A distributable Library that turns the raw Iceberg metadata of any number of
catalogs on one ClickHouse server into navigable views, then explores them
with two ready-made dashboards. Everything reads Iceberg *metadata*
(metadata.json, manifest lists, the S3 object listing) — no table data is
scanned, so every tile is cheap except where marked.

| File | What it is |
|---|---|
| [`examples/iceberg-install.json`](../examples/iceberg-install.json) | Installer: preflight + 4 generator entries (catalog DDL, union layer, chmem seed, per-catalog drill-down). Nothing favorited. |
| [`examples/iceberg-catalog-dashboard.json`](../examples/iceberg-catalog-dashboard.json) | **BI dashboard** — rows/storage/files per table, growth curves, commit cadence, warehouse census, schema width. |
| [`examples/iceberg-dba-dashboard.json`](../examples/iceberg-dba-dashboard.json) | **DBA dashboard** — snapshot-expiry backlog, manifest fragmentation, MOR delete manifests, metadata bloat, object census, plus two **log panels** (snapshot commit timeline, metadata-version timeline) and non-favorited detail tables. |
| [`examples/iceberg-templates/`](../examples/iceberg-templates/) | The tokenized SQL/JSON templates embedded into the install file. |
| [`examples/mjs/build-iceberg-install.mjs`](../examples/mjs/build-iceberg-install.mjs) | Rebuilds `iceberg-install.json` from the templates (mechanical escaping only — edit templates, never the JSON). |
| [`examples/mjs/build-iceberg-dashboards.mjs`](../examples/mjs/build-iceberg-dashboards.mjs) | Rebuilds both dashboard files, deriving each chart's `panel.key` live from a real cluster. |

## Precondition

The catalog must be a **REST catalog whose warehouse is a plain `s3://`
bucket that the ClickHouse server's own IAM role can read** (keyless `s3()`
access). The views bypass the catalog and read the metadata files straight
off S3, so:

- **Glue catalogs with vended credentials** — not supported (credentials are
  per-table and the server role can't list the warehouse).
- **S3Tables catalogs** (ARN warehouse) — not supported (no plain-S3 URL).
- A REST catalog whose bucket the server role *can't* read — the preflight
  entry fails with the S3 access error; don't install.

Also recommended: `access_control_improvements.enable_read_write_grants =
true` on the server. Without it the bucket-scoped `GRANT READ ON S3(...)`
held by the views' definer user silently degrades to unrestricted `S3 ON *.*`
(fail-open — verified on 26.3).

## Install walkthrough

1. **File ▸ Append** `iceberg-install.json` (Append, not Open, so an existing
   Library is kept). Read the *Start here* entry.
2. **Preflight** — fill `warehouse_url` (the https:// virtual-host form of
   the warehouse bucket, e.g. `s3://my-bucket` →
   `https://my-bucket.s3.us-east-1.amazonaws.com`) and Run on a connection
   that can use `s3()`. It must report your tables.
3. **Generate: catalog install DDL** — fill `catalog` (short lowercase name;
   becomes database `ice_meta_<catalog>`), `warehouse_url`, `glob_depth`
   (`2` for the standard `namespace/table` layout), `grant_role` (existing
   role/user to receive read access, or `none`). Run, **copy the raw result
   cell**, paste into a new tab on an admin-capable connection, Run.
   Statement-by-statement progress appears in the results pane (idempotent —
   safe to re-run). Repeat per catalog.
4. **Generate: ice_meta_all union DDL** — no inputs; discovers the installed
   `ice_meta_<catalog>` databases and emits the cross-catalog union layer
   with a leading `catalog` column. Copy → new tab → Run. **Re-run this step
   whenever a catalog is added or removed.**
5. *(optional)* **Generate: chmem seed facts INSERT** — on servers with the
   chmem memory store, saves ~10 facts describing the views so MCP agents
   discover them via `search_schema`/`get_memory`.
6. **Generate: per-catalog drill-down Library** — emits a small Library JSON
   with the per-table tiles (`data_files(prefix)` / `parquet_stats(prefix)`
   can't be cross-catalog: database names aren't query-parameterizable and
   the manifest Avro partition tuple is table-specific). Save the output as
   `iceberg-<catalog>-drilldown.json` and File ▸ Append it.
7. **File ▸ Append** `iceberg-catalog-dashboard.json` and/or
   `iceberg-dba-dashboard.json`, then Library ▸ *Open as dashboard*.

> Appending both dashboard files merges their tiles into one Dashboard —
> that's how the app works (the Dashboard *is* the favorited subset of the
> current Library), not a bug. Keep them in separate Libraries (or
> unfavorite one persona's tiles) if you want them separate.

## What the views expose

Per catalog (`ice_meta_<catalog>`), all `DEFINER = s3_reader SQL SECURITY
DEFINER` so readers need zero S3 privilege:

| View | One row per | Notes |
|---|---|---|
| `tables` | Iceberg table | current metadata.json: uuid, location, current snapshot, counts, properties |
| `snapshots` | (table, snapshot) | full history; current totals need `argMax(..., sequence_number)` |
| `schema_columns` | column | current schema |
| `partition_spec` | partition field | default spec |
| `manifest_lists` | manifest per manifest-list | join `list_snapshot_id = tables.current_snapshot_id` for the live set |
| `objects` | S3 object | whole-warehouse census classified by Iceberg role |
| `metadata_log` | prior metadata.json version | metadata bloat / version timeline |
| `data_files(prefix)` | data file | parameterized per table (`prefix` = `tables.s3_prefix`) |
| `parquet_stats(prefix)` | table | Parquet footers — **slow**, on demand only |

`ice_meta_all` unions the seven zero-arg views across catalogs with a leading
`catalog` column; every dashboard tile targets it with
`/*[ AND catalog = {catalog:String} ]*/` so one filter-bar field drives the
whole dashboard (blank = all catalogs).

## Known limitations

- The `catalog` filter is a freeform text box; query-backed dropdown options
  arrive with [#160](https://github.com/Altinity/altinity-sql-browser/issues/160)
  (`SELECT DISTINCT catalog FROM ice_meta_all.tables` would feed it).
- The install flow is copy-paste-run by design — dashboard Setup sources
  ([#175](https://github.com/Altinity/altinity-sql-browser/issues/175)) may
  later run such scripts as first-class dashboard members.
- 26.3 wildcard grants (`ON \`ice_meta_*\`.*`) are stored but did not satisfy
  `CREATE DATABASE` checks in testing — grant installer privileges explicitly.

## Reproduce / rebuild

```sh
node examples/mjs/build-iceberg-install.mjs
node examples/mjs/build-iceberg-dashboards.mjs   # ICE_CH_CMD overrides the client command
```

Authored and e2e-tested against the `cw-metrics` dev cluster (ClickHouse
26.3.10, Altinity antalya build) with a REST catalog (`ice`, two `logs.*`
tables) as the positive path, and Glue/S3Tables catalogs plus an
unreadable-bucket REST catalog as deliberate negative paths for the
preflight.
