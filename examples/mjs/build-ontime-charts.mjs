// Refresh the live schema keys in examples/ontime-charts.json against the
// configured antalya ClickHouse connection. The checked-in bundle is the
// authored source of truth for SQL, semantic tile order, grafana-grid sizing,
// filters/defaults/targets, KPI field configuration, and the flow fallback.
//
// Run: node examples/mjs/build-ontime-charts.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeExampleBundle } from './example-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'ontime-charts.json');
const document = JSON.parse(readFileSync(outPath, 'utf8'));

const ch = (query) => execFileSync(
  'clickhouse-client', [
    '--connection', 'antalya',
    '--param_from', '2023-01-01', '--param_to', '2023-12-31',
    '--query', query,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

function schemaKey(sql) {
  return ch(`DESCRIBE (${sql})`)
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, type] = line.split('\t');
      return `${name}:${type}`;
    })
    .join('|');
}

for (const query of document.queries) {
  if (!query.spec?.panel?.cfg?.type) continue;
  const key = schemaKey(query.sql);
  query.spec.panel.key = key;
  console.log(`${query.id.padEnd(14)} ${query.spec.panel.cfg.type.padEnd(5)} ${key}`);
}

writeExampleBundle(outPath, {
  exportedAt: new Date().toISOString(),
  metadata: document.metadata,
  queries: document.queries,
  dashboards: document.dashboards,
});
console.log(`wrote ${outPath}`);
