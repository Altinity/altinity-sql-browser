// Normalize every checked-in JSON example to the current portable bundle,
// saved-query Spec v1, and Dashboard document v1 contracts.
//
// Run:
//   node examples/mjs/normalize-examples.mjs
//   node examples/mjs/normalize-examples.mjs --check

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDashboard,
  queryDashboardRole,
  serializeExampleBundle,
} from './example-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, '..');
const checkOnly = process.argv.includes('--check');

const CONFIG = {
  'kpi-panel.json': {
    id: 'kpi-panel-example', title: 'KPI panel example', preset: 'report',
    description: 'Scalar and named-tuple KPI presentation example.',
  },
  'text-log-panel.json': {
    id: 'text-log-panel-example', title: 'Server log panel example', preset: 'report',
    description: 'Parameterized system.text_log dashboard example.',
  },
  'shop-charts.json': {
    id: 'shop-charts', title: 'Shop analytics', preset: 'columns-2',
    description: 'Chart examples over the sample shop dataset.',
  },
  'query-log-explorer.json': {
    id: 'query-log-explorer', title: 'Query log explorer', preset: 'columns-2',
    description: 'ClickHouse query-log health, performance, and usage dashboard.',
    sourceByParameter: { user: 'qle-filter', query_kind: 'qle-filter' },
  },
  'grafana-clickhouse-ops-enhanced.json': {
    id: 'clickhouse-ops-enhanced', title: 'ClickHouse operations', preset: 'columns-2',
    description: 'Operational ClickHouse dashboard adapted from the Grafana dashboard.',
    sourceByParameter: {
      is_initial_query: 'gco-filter',
      query_kind: 'gco-filter',
      user: 'gco-filter',
      exception_code: 'gco-filter',
      query_hash: 'gco-filter',
      metric: 'gco-filter',
    },
  },
  'ontime-charts.json': {
    id: 'ontime-chart-gallery', title: 'On-time chart gallery', preset: 'columns-2', allPanels: true,
    description: 'Chart gallery over the public ontime flight dataset.',
  },
  'system-explorer-charts.json': {
    id: 'system-explorer', title: 'ClickHouse system explorer', preset: 'columns-2',
    description: 'Operational views over ClickHouse system tables.',
  },
  'iceberg-catalog-dashboard.json': {
    id: 'iceberg-catalog-explorer', title: 'Iceberg catalog explorer — BI', preset: 'columns-2',
    description: 'Business intelligence view of Iceberg catalog metadata.',
  },
  'iceberg-dba-dashboard.json': {
    id: 'iceberg-dba-explorer', title: 'Iceberg catalog explorer — DBA', preset: 'columns-2',
    description: 'Maintenance and health view of Iceberg catalog metadata.',
  },
  'iceberg-install.json': {
    dashboard: false, title: 'Iceberg Catalog Explorer installer',
    description: 'Administrative setup and generation queries for the Iceberg examples.',
  },
};

function queriesOf(document, name) {
  if (!document || !Array.isArray(document.queries)) {
    throw new Error(`${name}: expected a queries array`);
  }
  return document.queries;
}

function hasPanel(query) {
  return !!query?.spec?.panel?.cfg?.type;
}

function cleanStaleWording(value) {
  if (typeof value === 'string') {
    return value
      .replaceAll('saved-queries Library JSON', 'portable bundle JSON')
      .replaceAll('saved-queries Library', 'portable bundle')
      .replaceAll('drill-down Library', 'drill-down portable bundle')
      .replaceAll('per-catalog drill-down Library', 'per-catalog drill-down portable bundle')
      .replaceAll('File ▸ Append it', 'File → Replace workspace…')
      .replaceAll('then File > Append it', 'then File > Replace workspace…')
      .replace(
        'Every favorite below is a Panel, except one **Filter**-role source',
        'Every bundled Dashboard tile below is a Panel; one separate **Filter**-role source',
      );
  }
  if (Array.isArray(value)) return value.map(cleanStaleWording);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cleanStaleWording(child)]));
  }
  return value;
}

function tileQueryIds(queries, config) {
  const panelQueries = queries.filter((query) => queryDashboardRole(query) === 'panel' && hasPanel(query));
  if (config.allPanels) return panelQueries.map((query) => query.id);
  return panelQueries.filter((query) => query.spec?.favorite === true).map((query) => query.id);
}

function normalizeDocument(name, document, config) {
  const queries = cleanStaleWording(queriesOf(document, name));
  const selectedIds = config.dashboard === false ? [] : tileQueryIds(queries, config);
  const dashboards = selectedIds.length ? [buildDashboard({
    id: config.id,
    title: config.title,
    description: config.description,
    queries,
    tileQueryIds: selectedIds,
    sourceByParameter: config.sourceByParameter,
    preset: config.preset,
  })] : [];

  return serializeExampleBundle({
    exportedAt: typeof document.exportedAt === 'string' ? document.exportedAt : '2026-01-01T00:00:00.000Z',
    metadata: { name: config.title, description: config.description },
    queries,
    dashboards,
  });
}

const changed = [];
for (const name of readdirSync(examples).filter((item) => item.endsWith('.json')).sort()) {
  const path = resolve(examples, name);
  const source = readFileSync(path, 'utf8');
  const document = JSON.parse(source);
  const config = CONFIG[name];
  if (!config) throw new Error(`${name}: add an explicit example normalization configuration`);
  const normalized = normalizeDocument(name, document, config);
  if (normalized !== source) {
    changed.push(name);
    if (!checkOnly) writeFileSync(path, normalized);
  }
}

const templateName = 'iceberg-templates/ice_meta_drilldown.json.tmpl';
const templatePath = resolve(examples, templateName);
const templateSource = readFileSync(templatePath, 'utf8');
const templateDocument = JSON.parse(templateSource);
const templateQueries = cleanStaleWording(queriesOf(templateDocument, templateName));
const templateTileIds = tileQueryIds(templateQueries, {});
const templateDashboard = buildDashboard({
  id: 'iceberg-__CATALOG__-drilldown',
  title: 'Iceberg __CATALOG__ drill-down',
  description: 'Per-table data-file, size, and partition analysis.',
  queries: templateQueries,
  tileQueryIds: templateTileIds,
  preset: 'columns-2',
});
const normalizedTemplate = serializeExampleBundle({
  exportedAt: templateDocument.exportedAt || '2026-01-01T00:00:00.000Z',
  metadata: {
    name: 'Iceberg __CATALOG__ drill-down',
    description: 'Generated per-catalog Iceberg drill-down bundle.',
  },
  queries: templateQueries,
  dashboards: [templateDashboard],
});
if (normalizedTemplate !== templateSource) {
  changed.push(templateName);
  if (!checkOnly) writeFileSync(templatePath, normalizedTemplate);
}

if (checkOnly && changed.length) {
  throw new Error(`Examples are not normalized: ${changed.join(', ')}`);
}

console.log(checkOnly
  ? `checked ${Object.keys(CONFIG).length} example bundles and the drill-down template`
  : `normalized ${changed.length} example artifact${changed.length === 1 ? '' : 's'}`);
