// Generator for examples/ontime-charts.json — a saved-queries "Library" file for
// the Altinity SQL Browser that demonstrates every chart feature against the
// public `ontime` flights dataset on the antalya cluster.
//
// Why a generator: the browser only restores a saved chart config when the
// entry's `spec.panel.key` exactly equals schemaKey(resultColumns) = "name:type|…"
// (see src/ui/results.js chartCfgFor / src/core/chart-data.js schemaKey).
// Hand-writing those type strings is error-prone, so we derive each key live
// from `DESCRIBE (<query>)` against the real cluster.
//
// Run:  node examples/build-ontime-charts.mjs   (needs `clickhouse-client --connection antalya`)
// Out:  examples/ontime-charts.json

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertValidLibraryDocument } from './validate-library.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CONNECTION = 'antalya';

// Each spec: a query + the chart we want it to open with. `cfg` matches the
// app's shape { type, x, y:[...], series }; x/series are column indices, y a
// list of measure-column indices. `view:'panel'` makes a click open the panel.
const SPECS = [
  {
    name: 'Busiest origin airports — 2023',
    description: 'Top 15 departure airports by flight count (joined to dim_airports for readable names). Horizontal Bar — hover any bar, long or short, to read its exact value.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT
    a.DisplayAirportName AS airport,
    count() AS flights
FROM ontime.fact_ontime AS f
INNER JOIN ontime.dim_airports AS a
    ON a.AirportCode = f.OriginCode AND a.IsLatest = 1
WHERE f.Year = 2023
GROUP BY airport
ORDER BY flights DESC
LIMIT 15`,
  },
  {
    name: 'Flights by month — 2023',
    description: 'Monthly US flight volume. A numeric column named "month" is detected as an ordinal axis → vertical Column chart, with K/M-humanised value ticks.',
    cfg: { type: 'bar', x: 0, y: [1], series: null },
    sql: `SELECT Month AS month, count() AS flights
FROM ontime.fact_ontime
WHERE Year = 2023
GROUP BY month
ORDER BY month`,
  },
  {
    name: 'Daily flights — 2023',
    description: 'One point per day across 2023 (~365 rows). A Date X axis is auto-detected as a time series → Line chart.',
    cfg: { type: 'line', x: 0, y: [1], series: null },
    sql: `SELECT FlightDate AS date, count() AS flights
FROM ontime.fact_ontime
WHERE Year = 2023
GROUP BY date
ORDER BY date`,
  },
  {
    name: 'Daily on-time rate — 2023',
    description: 'Share of flights arriving on time (< 15 min late) per day, as a percentage. Rendered as a filled Area chart.',
    cfg: { type: 'area', x: 0, y: [1], series: null },
    sql: `SELECT
    FlightDate AS date,
    round(100 * countIf(ArrDel15 = 0) / count(), 1) AS on_time_pct
FROM ontime.fact_ontime
WHERE Year = 2023
GROUP BY date
ORDER BY date`,
  },
  {
    name: 'Cancellation reasons — 2023',
    description: 'Why flights were cancelled in 2023 (carrier / weather / national air system / security). A small categorical breakdown → Pie chart with a legend.',
    cfg: { type: 'pie', x: 0, y: [1], series: null },
    sql: `SELECT
    multiIf(CancellationCode = 'A', 'Carrier',
            CancellationCode = 'B', 'Weather',
            CancellationCode = 'C', 'National Air System',
            CancellationCode = 'D', 'Security', 'Other') AS reason,
    count() AS cancellations
FROM ontime.fact_ontime
WHERE Year = 2023 AND Cancelled = 1
GROUP BY reason
ORDER BY cancellations DESC`,
  },
  {
    name: 'Monthly flights by carrier — 2023',
    description: 'Flights per month split across four major carriers (WN, AA, DL, UA). The "carrier" column is used as the Series, producing grouped bars with a per-carrier legend.',
    cfg: { type: 'bar', x: 0, y: [2], series: 1 },
    sql: `SELECT
    Month AS month,
    Carrier AS carrier,
    count() AS flights
FROM ontime.fact_ontime
WHERE Year = 2023 AND Carrier IN ('WN', 'AA', 'DL', 'UA')
GROUP BY month, carrier
ORDER BY month, carrier`,
  },
  {
    name: 'Average delay breakdown by carrier — 2023',
    description: 'Mean minutes of each delay cause (carrier, weather, NAS, late aircraft) for delayed flights, per carrier. Four measures plotted at once ("All measures") as grouped columns.',
    cfg: { type: 'bar', x: 0, y: [1, 2, 3, 4], series: null },
    sql: `SELECT
    Carrier AS carrier,
    round(avg(CarrierDelay), 1) AS carrier_delay,
    round(avg(WeatherDelay), 1) AS weather_delay,
    round(avg(NASDelay), 1) AS nas_delay,
    round(avg(LateAircraftDelay), 1) AS late_aircraft_delay
FROM ontime.fact_ontime
WHERE Year = 2023 AND ArrDel15 = 1
GROUP BY carrier
ORDER BY carrier_delay DESC
LIMIT 12`,
  },
  {
    name: 'Daily flights since 2022',
    description: 'Every day from 2022 onward (~1,460 points). The chart plots the first 500 and shows a "first 500 of N rows" note — the table view still has them all.',
    cfg: { type: 'line', x: 0, y: [1], series: null },
    sql: `SELECT FlightDate AS date, count() AS flights
FROM ontime.fact_ontime
WHERE FlightDate >= '2022-01-01'
GROUP BY date
ORDER BY date`,
  },
  {
    name: 'Flights by day of week — 2023',
    description: 'Volume by day of week (1 = Monday … 7 = Sunday). "dayofweek" is recognised as an ordinal axis → Column chart.',
    cfg: { type: 'bar', x: 0, y: [1], series: null },
    sql: `SELECT DayOfWeek AS dayofweek, count() AS flights
FROM ontime.fact_ontime
WHERE Year = 2023
GROUP BY dayofweek
ORDER BY dayofweek`,
  },
  {
    name: 'Worst average departure delay by airport — 2023',
    description: 'Airports with the highest mean departure delay (minutes) among those with ≥ 10,000 departures in 2023. Horizontal Bar of a non-count measure, joined for names.',
    cfg: { type: 'hbar', x: 0, y: [1], series: null },
    sql: `SELECT
    a.DisplayAirportName AS airport,
    round(avg(f.DepDelayMinutes), 1) AS avg_dep_delay
FROM ontime.fact_ontime AS f
INNER JOIN ontime.dim_airports AS a
    ON a.AirportCode = f.OriginCode AND a.IsLatest = 1
WHERE f.Year = 2023
GROUP BY airport
HAVING count() >= 10000
ORDER BY avg_dep_delay DESC
LIMIT 15`,
  },
];

const ch = (query) =>
  execFileSync('clickhouse-client', ['--connection', CONNECTION, '--query', query], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

// schemaKey == columns.map(c => c.name + ':' + c.type).join('|'), derived from
// DESCRIBE so it matches exactly what the app receives at run time.
function schemaKey(sql) {
  const out = ch(`DESCRIBE (${sql})`);
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { const [name, type] = l.split('\t'); return `${name}:${type}`; })
    .join('|');
}

const resultRows = (sql) => Number(ch(`SELECT count() FROM (${sql})`).trim());

const queries = SPECS.map((s, i) => {
  const key = schemaKey(s.sql);
  const rows = resultRows(s.sql);
  console.log(`#${i + 1} ${s.cfg.type.padEnd(4)} rows=${String(rows).padStart(5)}  key=${key}`);
  return {
    id: 's' + (i + 1),
    sql: s.sql,
    specVersion: 1,
    spec: {
      name: s.name,
      favorite: false,
      description: s.description,
      panel: { cfg: s.cfg, key },
      view: 'panel',
    },
  };
});

const doc = {
  format: 'altinity-sql-browser/saved-queries',
  version: 2,
  exportedAt: new Date().toISOString(),
  queries,
};

assertValidLibraryDocument(doc);

const outPath = resolve(here, 'ontime-charts.json');
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`\nwrote ${outPath} (${queries.length} queries)`);
