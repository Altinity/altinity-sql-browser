// Generator for examples/system-explorer-charts.json — a saved-queries
// "Library" file for the Altinity SQL Browser that explores ClickHouse's own
// system database: currently-running work, merges/mutations/replication
// health, storage, and historical query/part/error activity from the *_log
// tables. Ideas and query shapes are adapted (not ported 1:1 — no Grafana
// template macros) from Mikhail Filimonov's ClickHouse ops dashboard:
// https://gist.github.com/filimonov/271e5b27c085356c67db3c1bf2204506
//
// Why a generator: the browser only restores a saved chart config when the
// entry's `chart.key` exactly equals schemaKey(resultColumns) = "name:type|…"
// (see src/ui/results.js chartCfgFor / src/core/chart-data.js schemaKey).
// Hand-writing those type strings is error-prone (Enum8/LowCardinality wrap
// exactly), so we derive each key live from `DESCRIBE (<query>)` against a
// real cluster, read through FORMAT JSON so the type string matches exactly
// what the app's HTTP+JSON interface receives (clickhouse-client's default
// TSV output escapes embedded quotes differently and will silently produce a
// key that never matches at runtime).
//
// A handful of entries are plain live-snapshot tables (system.processes,
// system.merges, …) with no chart — those need SELECT privilege on the
// underlying table but no query history, and are commonly close to empty on
// an idle cluster (that's a legitimate result, not a bug).
//
// Every time-ranged *_log query shares two ClickHouse native query parameters,
// `{from:String}`/`{to:String}` (parsed via parseDateTimeBestEffort), instead
// of a hardcoded `now() - INTERVAL …`. Same param names across every entry
// means the Dashboard's global filter bar (#149 D3) renders ONE From/To pair
// that drives all six time-ranged tiles at once. DESCRIBE can't resolve an
// unbound parameter, so schemaKey() below binds throwaway test values via
// `--param_from`/`--param_to` purely to derive column types — the *shipped*
// SQL keeps the placeholders unbound for the browser to fill in.
//
// Run:  node examples/build-system-explorer-charts.mjs [connection-name]
// Needs a `clickhouse-client` connection with SELECT on system.* — NOT the
// narrow "demo" fixture user some clusters expose by default (it can't read
// system.processes/query_log/etc). Defaults to `github-admin`; this file was
// authored against the github.demo cluster via
//   kubectl exec chi-github-github-0-0-0 -c clickhouse-pod --
//     clickhouse-client --user clickhouse_operator --password "$PASS" ...
// since no adequately-privileged named CLI connection existed in that session.
// Out:  examples/system-explorer-charts.json

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CONNECTION = process.argv[2] || 'github-admin';

// Each spec: a query + (for chartable ones) the chart we want it to open
// with. `cfg` matches the app's shape { type, x, y:[...], series }; x/series
// are column indices, y a list of measure-column indices. A spec with no
// `cfg` is a live-snapshot table — no chart, opens in Table view.
const SPECS = [
  {
    name: 'Currently running queries',
    description: 'Live snapshot of system.processes — every query executing right now, slowest first. Empty when the cluster is idle; that\'s a real "nothing running" result, not an error.',
    sql: `SELECT query_id, user, elapsed, read_rows, formatReadableSize(memory_usage) AS memory, left(query, 80) AS query
FROM system.processes
ORDER BY elapsed DESC
LIMIT 20`,
  },
  {
    name: 'Merges in progress',
    description: 'Live snapshot of system.merges — background merges currently running, with progress and compressed size. Usually empty between merge cycles on a small cluster.',
    sql: `SELECT database, table, elapsed, round(progress * 100, 1) AS pct_done, num_parts, is_mutation, formatReadableSize(total_size_bytes_compressed) AS size
FROM system.merges
ORDER BY elapsed DESC
LIMIT 20`,
  },
  {
    name: 'Mutations in progress',
    description: 'Unfinished ALTER UPDATE/DELETE mutations from system.mutations, with the failure reason if one is stuck retrying.',
    sql: `SELECT database, table, mutation_id, command, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE NOT is_done
ORDER BY create_time
LIMIT 20`,
  },
  {
    name: 'Replication status',
    description: 'system.replicas health per table — leadership, read-only state, replication delay, and queue depth. Sorted worst-lag-first.',
    sql: `SELECT database, table, is_leader, is_readonly, absolute_delay, queue_size, inserts_in_queue, merges_in_queue
FROM system.replicas
ORDER BY absolute_delay DESC
LIMIT 20`,
  },
  {
    name: 'Stuck replication queue entries',
    description: 'system.replication_queue entries that have already failed and retried at least once, with the last exception — the first place to look when a replica falls behind.',
    sql: `SELECT database, table, type, create_time, num_tries, last_exception
FROM system.replication_queue
WHERE num_tries > 0
ORDER BY num_tries DESC
LIMIT 20`,
  },
  {
    name: 'Largest tables by disk usage',
    description: 'Every active part in system.parts, summed per table, largest first. Horizontal Bar — hover any bar for the exact byte count.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT concat(database, '.', table) AS table, sum(bytes_on_disk) AS disk_bytes
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY disk_bytes DESC
LIMIT 15`,
  },
  {
    name: 'Active parts by table',
    description: 'Active part *count* per table (not size) — a table climbing here between refreshes is trending toward "too many parts". Horizontal Bar.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT concat(database, '.', table) AS table, count() AS parts
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY parts DESC
LIMIT 15`,
  },
  {
    name: 'Cumulative error counters',
    description: 'system.errors — every error code the server has hit since last restart, most frequent first. A quick "what\'s actually going wrong here" check. Horizontal Bar.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT name, value AS times
FROM system.errors
WHERE value > 0
ORDER BY value DESC
LIMIT 15`,
  },
  {
    name: 'Queries per minute',
    description: 'Finished-query volume from system.query_log, bucketed per minute, over a {from:String}/{to:String} range (shared with every other time-ranged query below — the Dashboard filter bar renders one From/To pair that drives them all). A DateTime X axis is auto-detected as a time series → Line chart.',
    cfg: { type: 'line', x: 0, y: [1], series: null },
    sql: `SELECT toStartOfMinute(event_time) AS t, count() AS queries
FROM system.query_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String}) AND type = 'QueryFinish'
GROUP BY t
ORDER BY t`,
  },
  {
    name: 'Slowest query patterns — avg duration',
    description: 'Distinct query shapes (system.query_log grouped by normalized_query_hash) ranked by average duration over a {from:String}/{to:String} range. Horizontal Bar of a non-count measure.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT left(any(query), 50) AS query, avg(query_duration_ms) AS avg_duration_ms
FROM system.query_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String}) AND type = 'QueryFinish'
GROUP BY normalized_query_hash
ORDER BY avg_duration_ms DESC
LIMIT 15`,
  },
  {
    name: 'Query errors over time',
    description: 'Failed queries from system.query_log over a {from:String}/{to:String} range, broken down by ClickHouse error name. The "error" column is used as the Series, producing grouped/stacked bars per error code.',
    cfg: { type: 'bar', x: 0, y: [2], series: 1 },
    sql: `SELECT toStartOfHour(event_time) AS t, errorCodeToName(exception_code) AS error, count() AS n
FROM system.query_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String}) AND exception_code != 0
GROUP BY t, error
ORDER BY t`,
  },
  {
    name: 'Part lifecycle events over time',
    description: 'system.part_log over a {from:String}/{to:String} range — new/merged/mutated/downloaded/removed parts per hour, one query instead of five separate panels. "event_type" is the Series.',
    cfg: { type: 'bar', x: 0, y: [2], series: 1 },
    sql: `SELECT toStartOfHour(event_time) AS t, event_type, count() AS n
FROM system.part_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String})
GROUP BY t, event_type
ORDER BY t`,
  },
  {
    name: 'Memory usage over time',
    description: 'Average tracked memory (system.metric_log\'s CurrentMetric_MemoryTracking) per minute over a {from:String}/{to:String} range. Line chart.',
    cfg: { type: 'line', x: 0, y: [1], series: null },
    sql: `SELECT toStartOfMinute(event_time) AS t, avg(CurrentMetric_MemoryTracking) AS memory_bytes
FROM system.metric_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String})
GROUP BY t
ORDER BY t`,
  },
  {
    name: 'Query cost breakdown — slowest patterns (detail)',
    description: 'The deep-dive version of "Slowest query patterns": executions, max/avg duration, rows and bytes read, and p99 memory per query shape over a {from:String}/{to:String} range. Table view — too many columns for one chart, but the full picture behind the bar chart above.',
    sql: `SELECT
    normalized_query_hash,
    left(argMax(query, query_duration_ms), 60) AS sample_query,
    count() AS executions,
    max(query_duration_ms) AS max_ms,
    avg(query_duration_ms) AS avg_ms,
    sum(read_rows) AS read_rows,
    formatReadableSize(sum(read_bytes)) AS read_bytes,
    quantile(0.99)(memory_usage) AS p99_memory
FROM system.query_log
WHERE event_time BETWEEN parseDateTimeBestEffort({from:String}) AND parseDateTimeBestEffort({to:String}) AND type = 'QueryFinish'
GROUP BY normalized_query_hash
ORDER BY avg_ms DESC
LIMIT 15`,
  },
];

// Throwaway values just to let DESCRIBE/FORMAT JSON resolve column types for
// queries that reference {from:String}/{to:String} — never shipped in the
// output; the JSON's `sql` keeps the placeholders unbound.
const TEST_FROM = '2026-07-01 00:00:00';
const TEST_TO = '2026-07-08 00:00:00';

const ch = (query) =>
  execFileSync('clickhouse-client', [
    '--connection', CONNECTION,
    '--param_from', TEST_FROM,
    '--param_to', TEST_TO,
    '--query', query,
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

// schemaKey == columns.map(c => c.name + ':' + c.type).join('|'), derived via
// FORMAT JSON (not clickhouse-client's default TSV, which escapes embedded
// quotes in e.g. an Enum8(...) type string differently from the HTTP+JSON
// interface the app actually uses) so it matches exactly what the browser
// receives at run time.
function schemaKey(sql) {
  const out = JSON.parse(ch(`SELECT * FROM (${sql}) LIMIT 1 FORMAT JSON`));
  return out.meta.map((m) => `${m.name}:${m.type}`).join('|');
}

const queries = SPECS.map((s, i) => {
  const base = {
    id: 'sys-' + (i + 1),
    name: s.name,
    sql: s.sql,
    favorite: !!s.cfg,
    description: s.description,
  };
  if (!s.cfg) return base;
  const key = schemaKey(s.sql);
  console.log(`#${i + 1} ${s.cfg.type.padEnd(4)} key=${key}`);
  return { ...base, chart: { cfg: s.cfg, key }, view: 'chart' };
});

const doc = {
  format: 'altinity-sql-browser/saved-queries',
  version: 1,
  exportedAt: new Date().toISOString(),
  queries,
};

const outPath = resolve(here, 'system-explorer-charts.json');
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nwrote ${outPath} (${queries.length} queries, ${queries.filter((q) => q.favorite).length} favorited for the Dashboard)`);
