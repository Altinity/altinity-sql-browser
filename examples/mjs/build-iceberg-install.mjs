// Generator for examples/iceberg-install.json — the installer Library for the
// Iceberg Catalog Explorer (see docs/ICEBERG-CATALOG-EXPLORER-DEMO.md).
//
// Why a generator: the install entries embed ~250-line SQL/JSON templates
// (examples/iceberg-templates/*.tmpl) inside ClickHouse string literals, and
// the double escaping (backslashes + quote doubling for SQL, then JSON for the
// Library file) must never be maintained by hand. This script does ONLY that
// mechanical escaping — edit the .tmpl files, never iceberg-install.json.
//
// Run:  node examples/mjs/build-iceberg-install.mjs
// Out:  examples/iceberg-install.json

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeExampleBundle } from './example-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tmpl = (name) => readFileSync(resolve(here, 'iceberg-templates', name), 'utf8');

// ClickHouse single-quoted string literal: backslash is an escape character and
// must be doubled BEFORE quote doubling, or template text like the \n inside
// the drill-down JSON's "sql" fields would be unescaped into real newlines by
// the ClickHouse parser and corrupt the emitted JSON.
const chLiteral = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

const catalogTmpl = tmpl('ice_meta_catalog.sql.tmpl');
const seedTmpl = tmpl('ice_meta_seed_facts.json.tmpl');
const drilldownTmpl = tmpl('ice_meta_drilldown.json.tmpl');

// Shared param plumbing (ClickHouse SQL fragments used inside the generators).
// catalog: identifier-safe, validated first so a bad value fails at generation
// time, not as a syntax error deep inside 200 lines of pasted DDL.
const CATALOG_GUARD =
  "throwIf(NOT match({catalog:String}, '^[a-z][a-z0-9_]*$'), 'catalog must match ^[a-z][a-z0-9_]*$ (it becomes a database/role name suffix)')";
const URL_NORM = "trim(TRAILING '/' FROM {warehouse_url:String})";
const URL_GUARD =
  "throwIf(NOT startsWith({warehouse_url:String}, 'https://'), 'warehouse_url must be the https:// virtual-host form of the bucket, e.g. https://my-bucket.s3.us-east-1.amazonaws.com (convert s3://my-bucket)')";
// glob_depth 2 => glob */*  and regex [^/]+/[^/]+  (namespace/table). Both the
// s3() glob and the extract() regexes must agree, so both derive from it here.
const NS_GLOB = "arrayStringConcat(arrayMap(x -> '*', range(toUInt64(greatest({glob_depth:UInt8}, 1)))), '/')";
const NS_RE = "arrayStringConcat(arrayMap(x -> '[^/]+', range(toUInt64(greatest({glob_depth:UInt8}, 1)))), '/')";
// grant_role uses the sentinel 'none' (the browser blocks a run on blank
// required params, so "optional" is expressed as an explicit value).
const GRANT_LINE =
  "if(lower({grant_role:String}) IN ('none', '-', ''), '-- (no reader-role grant requested; GRANT ice_meta_' || {catalog:String} || '_reader_role TO <role-or-user> yourself)', 'GRANT ice_meta_' || {catalog:String} || '_reader_role TO `' || {grant_role:String} || '`;')";

const queries = [];

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i0',
  name: 'Start here: Iceberg Catalog Explorer install',
  sql: '',
  favorite: false,
  description: 'Read me first. The walkthrough for installing ice_meta_<catalog> navigation views with the generator entries below.',
  panel: {
    cfg: {
      type: 'text',
      content: `## Iceberg Catalog Explorer — install walkthrough

Turns the raw Iceberg metadata of a catalog into queryable ClickHouse views
(\`ice_meta_<catalog>.tables / snapshots / schema_columns / partition_spec /
manifest_lists / objects / metadata_log\` + parameterized \`data_files(prefix)\` /
\`parquet_stats(prefix)\`), plus a cross-catalog union layer \`ice_meta_all\`.

**Precondition**: the catalog must be a REST catalog whose warehouse is a plain
\`s3://\` bucket the ClickHouse pod's IAM role can read (keyless \`s3()\`).
Glue vended-credentials and S3Tables (ARN warehouse) catalogs are **not**
supported by this raw-S3 approach. Also make sure
\`access_control_improvements.enable_read_write_grants = true\` on the server,
or the bucket-scoped S3 grant used by the views fail-opens to unrestricted S3.

**Steps** (run 1–3 on a connection that may CREATE databases/views/users/roles
and hold+grant \`READ ON S3\`):

1. **Preflight** — fill \`warehouse_url\` (https form) on the *Preflight* entry
   and Run. It must report your tables; an access error or 0 files means stop.
2. **Install the catalog** — fill \`catalog\` (short name, e.g. \`ice\`),
   \`warehouse_url\`, \`glob_depth\` (\`2\` for the usual \`namespace/table\` layout)
   and \`grant_role\` (an existing role/user to grant read access to, or \`none\`)
   on *Generate: catalog install DDL*. Run, **copy the raw result**, paste into
   a new tab, Run. Repeat per catalog.
3. **Union layer** — Run *Generate: ice_meta_all union DDL* (no inputs), copy
   the result into a new tab, Run. Re-run this step whenever you add or remove
   a catalog.
4. *(optional, needs the chmem memory store + \`memory_writer\`)* — *Generate:
   chmem seed facts INSERT*: run, copy, run in a new tab. Makes the views
   self-describing to MCP agents.
5. **Drill-down tiles** — *Generate: per-catalog drill-down Library*: run,
   copy the JSON, save as \`iceberg-<catalog>-drilldown.json\`, then
   File ▸ Append it. Gives per-table small-file / partition-skew / Parquet
   tiles for that catalog.

Then File ▸ Append \`iceberg-catalog-dashboard.json\` (BI) and/or
\`iceberg-dba-dashboard.json\` (DBA + log panels) and open the Dashboard.

To **remove** a catalog, see the comment block at the end of its generated
install script.`,
    },
  },
  view: 'panel',
});

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i1',
  name: 'Preflight: is this catalog ice_meta-compatible?',
  sql: `WITH ${URL_GUARD} AS _g
SELECT
  count()                                                    AS metadata_json_files,
  uniqExact(extract(_path, '([^/]+/[^/]+)/metadata/'))       AS tables_found,
  if(count() = 0,
     'NOT COMPATIBLE: bucket is readable but holds no <namespace>/<table>/metadata/*.metadata.json objects at depth 2. Wrong warehouse_url, non-standard layout (try a different glob_depth in the install generator), or not an Iceberg REST warehouse.',
     'OK: warehouse is raw-S3 readable and has Iceberg tables at depth 2 (namespace/table). Proceed with "Generate: catalog install DDL".') AS verdict
FROM s3(concat(${URL_NORM}, '/*/*/metadata/*.metadata.json'), 'RawBLOB')`,
  favorite: false,
  description:
    'Step 1. Fill warehouse_url with the https:// form of the catalog warehouse bucket (s3://my-bucket -> https://my-bucket.s3.<region>.amazonaws.com) and Run ON THE INSTALLER/ADMIN CONNECTION. An S3 AccessDenied error = the ClickHouse server role cannot read that bucket (Glue vended-credentials catalogs fail here by design) - do not install. A "Host is empty in S3 URI" / URI-parse error = the value is not an https:// bucket URL (an S3Tables ARN warehouse, for example, is not supported). Checks the standard depth-2 namespace/table layout.',
  view: 'table',
});

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i2',
  name: 'Generate: catalog install DDL',
  sql: `WITH
  ${CATALOG_GUARD} AS _g1,
  ${URL_GUARD} AS _g2,
  ${URL_NORM} AS _url,
  ${NS_GLOB} AS _glob,
  ${NS_RE} AS _re,
  ${GRANT_LINE} AS _grant_line
SELECT replaceAll(replaceAll(replaceAll(replaceAll(replaceAll(
  ${chLiteral(catalogTmpl)},
  '__GRANT_ROLE_LINE__', _grant_line),
  '__WAREHOUSE_URL__', _url),
  '__NS_GLOB__', _glob),
  '__NS_RE__', _re),
  '__CATALOG__', {catalog:String}) AS install_sql
FORMAT TSVRaw`,
  favorite: false,
  description:
    'Step 2, once per catalog. Inputs: catalog = short lowercase name (becomes database ice_meta_<catalog>); warehouse_url = https:// bucket root from the preflight; glob_depth = 2 for the standard namespace/table layout (3 for an extra nesting level); grant_role = existing role or user to receive read access, or none. Run, then COPY the single raw result cell into a NEW TAB on an admin connection and Run it there (multiquery). Idempotent - safe to re-run.',
  view: 'table',
});

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i3',
  name: 'Generate: ice_meta_all union DDL',
  sql: `WITH cats AS (
  SELECT name AS db, replaceOne(name, 'ice_meta_', '') AS catalog
  FROM system.databases
  WHERE match(name, '^ice_meta_[a-z0-9_]+$') AND name != 'ice_meta_all'
)
SELECT concat(
  '-- ice_meta_all: cross-catalog union layer, generated from the live set of\\n',
  '-- ice_meta_<catalog> databases (', (SELECT arrayStringConcat(arraySort(groupArray(catalog)), ', ') FROM cats), ').\\n',
  '-- Re-generate + re-run whenever a catalog is added or removed.\\n\\n',
  'CREATE DATABASE IF NOT EXISTS ice_meta_all ENGINE = Atomic;\\n\\n',
  arrayStringConcat(arraySort(groupArray(ddl)), '\\n'),
  '\\nCREATE ROLE IF NOT EXISTS ice_meta_all_reader_role;\\n',
  'GRANT SHOW, SELECT ON ice_meta_all.* TO ice_meta_all_reader_role;\\n') AS union_sql
FROM (
  SELECT v, concat(
    'CREATE OR REPLACE VIEW ice_meta_all.', v, '\\n',
    'DEFINER = s3_reader SQL SECURITY DEFINER\\nAS\\n',
    arrayStringConcat(arraySort(groupArray(
      concat('SELECT ''', catalog, ''' AS catalog, * FROM ', db, '.', v))), '\\nUNION ALL\\n'),
    ';\\n') AS ddl
  FROM cats
  CROSS JOIN (SELECT arrayJoin(['tables','snapshots','schema_columns','partition_spec','manifest_lists','objects','metadata_log']) AS v) AS vs
  GROUP BY v
)
WHERE throwIf((SELECT count() FROM cats) = 0, 'no ice_meta_<catalog> databases found - run "Generate: catalog install DDL" first') = 0
FORMAT TSVRaw`,
  favorite: false,
  description:
    'Step 3, and again after every catalog add/remove. No inputs - it discovers the installed ice_meta_<catalog> databases from system.databases and emits DDL for ice_meta_all: the 7 zero-arg views unioned across catalogs with a leading `catalog` column (data_files/parquet_stats stay per-catalog - Avro schema binding is table-specific). Copy the raw result into a new tab on the admin connection and Run.',
  view: 'table',
});

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i4',
  name: 'Generate: chmem seed facts INSERT',
  sql: `WITH
  ${CATALOG_GUARD} AS _g1
SELECT concat(
  '-- chmem seed for ice_meta_', {catalog:String}, ' - run as a user holding memory_writer.\\n',
  '-- async_insert must be 0 or the store records an empty author (currentUser() blanks).\\n',
  'INSERT INTO mcp.entries_raw (source_db, facts) SETTINGS async_insert = 0 VALUES (''ice_meta_', {catalog:String}, ''', ''',
  replaceAll(replaceAll(${chLiteral(seedTmpl)}, '__CATALOG__', {catalog:String}), '''', ''''''),
  ''');') AS seed_sql
FORMAT TSVRaw`,
  favorite: false,
  description:
    'Optional step 4 - only on servers with the chmem memory store (an `mcp` database with entries_raw). Input: catalog. Emits an INSERT that saves ~10 facts (overview, naming/current-state/cost notes, 2 recipes, 2 join paths) describing the ice_meta_<catalog> views, so MCP agents discover them via search_schema/inspect_table/get_memory. The facts payload is also a valid save_memory body. Re-seeding the same slugs needs supersede:true - edit the emitted JSON if you are updating.',
  view: 'table',
});

// ---------------------------------------------------------------------------
queries.push({
  id: 'ice-i5',
  name: 'Generate: per-catalog drill-down Library',
  sql: `WITH
  ${CATALOG_GUARD} AS _g1
SELECT replaceAll(${chLiteral(drilldownTmpl)}, '__CATALOG__', {catalog:String}) AS library_json
FORMAT TSVRaw`,
  favorite: false,
  description:
    'Step 5, once per catalog. Input: catalog (must already be installed). Emits a complete saved-queries Library JSON with the per-table drill-down tiles (data files, small-file buckets, partition skew, on-demand Parquet footer stats) bound to ice_meta_<catalog> - database names cannot be query parameters, so these tiles are generated per catalog. Copy the raw result, save it as iceberg-<catalog>-drilldown.json, then File > Append it. The tiles share one `prefix` filter (values = SELECT s3_prefix FROM ice_meta_<catalog>.tables).',
  view: 'table',
});

// ---------------------------------------------------------------------------
const normalizedQueries = queries.map(({ id, sql, name, favorite, description, panel, view }) => ({
  id,
  sql,
  specVersion: 1,
  spec: {
    name,
    favorite,
    ...(description ? { description } : {}),
    ...(panel ? { panel } : {}),
    ...(view ? { view } : {}),
  },
}));

const out = resolve(here, 'iceberg-install.json');
writeExampleBundle(out, {
  exportedAt: new Date().toISOString(),
  metadata: {
    name: 'Iceberg Catalog Explorer installer',
    description: 'Administrative setup and generation queries for the Iceberg examples.',
  },
  queries: normalizedQueries,
  dashboards: [],
});
console.log(`wrote ${out} (${queries.length} entries)`);
