// Shared authoring helpers for checked-in examples.
//
// Examples are canonical portable bundles, not legacy Library v2 documents.
// This module intentionally has no dependency on the TypeScript application
// graph so the generators remain directly runnable with Node.js. The complete
// application codec validates every generated artifact in
// tests/unit/spec-examples.test.js.

import { writeFileSync } from 'node:fs';

export const PORTABLE_BUNDLE_SCHEMA =
  'https://altinity.com/schemas/altinity-sql-browser/portable-bundle-v1.schema.json';
export const PORTABLE_BUNDLE_FORMAT = 'altinity-sql-browser/portable-bundle';

const clone = (value) => JSON.parse(JSON.stringify(value));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function queryDashboardRole(query) {
  const role = query?.spec?.dashboard?.role;
  return typeof role === 'string' ? role : 'panel';
}

function queryPanelType(query) {
  const type = query?.spec?.panel?.cfg?.type;
  return typeof type === 'string' ? type : null;
}

function sizeHintsFor(query) {
  const type = queryPanelType(query);
  if (type === 'kpi') return { preferred: 'compact', minimum: 'compact', aspectRatio: 2 };
  if (type === 'text') return { preferred: 'wide', minimum: 'medium', aspectRatio: 2 };
  if (type === 'table' || type === 'logs') {
    return { preferred: 'wide', minimum: 'medium', aspectRatio: 1.6 };
  }
  return { preferred: 'medium', minimum: 'compact', aspectRatio: 1.5 };
}

function placementFor(query, preset) {
  const type = queryPanelType(query);
  if (preset === 'report') {
    return { span: 1, height: type === 'kpi' ? 'compact' : 'large' };
  }
  if (type === 'text' || type === 'table' || type === 'logs') {
    return { span: 2, height: 'large' };
  }
  if (type === 'kpi') return { span: 1, height: 'compact' };
  return { span: 1, height: 'large' };
}

function flowLayout(selected, tiles, preset, placements = {}) {
  const items = Object.fromEntries(selected.map((query, index) => [
    tiles[index].id,
    placements[query.id] || placementFor(query, preset),
  ]));
  return { type: 'flow', version: 1, preset, items };
}

function scanParameterNames(sql) {
  const names = [];
  const seen = new Set();
  const re = /\{([A-Za-z_][A-Za-z0-9_]*):/g;
  for (const match of String(sql || '').matchAll(re)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

export function buildDashboard({
  id,
  title,
  description,
  queries,
  tileQueryIds,
  sourceByParameter = {},
  preset = 'columns-2',
  filters: authoredFilters,
  grid,
  flowPlacements = {},
  revision = 1,
}) {
  if (!id || !title) throw new Error('Dashboard id and title are required');
  if (!['report', 'columns-2', 'columns-3'].includes(preset)) {
    throw new Error(`Unsupported flow preset ${JSON.stringify(preset)}`);
  }

  const byId = new Map(queries.map((query) => [query.id, query]));
  const selected = tileQueryIds.map((queryId) => {
    const query = byId.get(queryId);
    if (!query) throw new Error(`Dashboard ${id} references unknown query ${JSON.stringify(queryId)}`);
    if (queryDashboardRole(query) !== 'panel') {
      throw new Error(`Dashboard ${id} tile query ${JSON.stringify(queryId)} is not a Panel query`);
    }
    return query;
  });

  const tiles = selected.map((query) => ({ id: `tile-${query.id}`, queryId: query.id }));
  const fallback = flowLayout(selected, tiles, preset, flowPlacements);

  const parameterNames = [];
  const seenParameters = new Set();
  for (const query of selected) {
    for (const name of scanParameterNames(query.sql)) {
      if (!seenParameters.has(name)) {
        seenParameters.add(name);
        parameterNames.push(name);
      }
    }
  }

  const inferredFilters = parameterNames.map((parameter) => ({
    id: `filter-${parameter}`,
    parameter,
    ...(sourceByParameter[parameter] ? { sourceQueryId: sourceByParameter[parameter] } : {}),
  }));

  const filters = authoredFilters === undefined ? inferredFilters : clone(authoredFilters);
  const layout = grid
    ? {
        type: 'grafana-grid',
        version: 1,
        items: Object.fromEntries(selected.map((query, index) => [
          tiles[index].id,
          grid[query.id] || { span: 6, height: 2 },
        ])),
        fallback,
      }
    : fallback;

  return {
    documentVersion: 1,
    id,
    title,
    ...(description ? { description } : {}),
    revision,
    layout,
    filters,
    tiles,
  };
}

function normalizeQueriesForDashboards(queries, dashboards) {
  const tileQueryIds = new Set();
  const filterSourceIds = new Set();
  for (const dashboard of dashboards) {
    for (const tile of dashboard.tiles || []) tileQueryIds.add(tile.queryId);
    for (const filter of dashboard.filters || []) {
      if (filter.sourceQueryId) filterSourceIds.add(filter.sourceQueryId);
    }
  }

  return queries.map((raw) => {
    const query = clone(raw);
    query.spec = isObject(query.spec) ? query.spec : {};
    const dashboard = isObject(query.spec.dashboard) ? query.spec.dashboard : {};

    if (tileQueryIds.has(query.id)) {
      query.spec.favorite = true;
      query.spec.dashboard = {
        ...dashboard,
        role: 'panel',
        sizeHints: isObject(dashboard.sizeHints) ? dashboard.sizeHints : sizeHintsFor(query),
      };
    } else if (filterSourceIds.has(query.id) || dashboard.role === 'filter') {
      query.spec.favorite = false;
      query.spec.dashboard = { ...dashboard, role: 'filter' };
    } else {
      query.spec.favorite = false;
      if (Object.keys(dashboard).length) query.spec.dashboard = dashboard;
    }
    return query;
  });
}

export function assertValidExampleBundle(document) {
  if (!isObject(document)) throw new Error('Example bundle must be an object');
  if (document.$schema !== PORTABLE_BUNDLE_SCHEMA) throw new Error('Example bundle has the wrong $schema');
  if (document.format !== PORTABLE_BUNDLE_FORMAT || document.version !== 1) {
    throw new Error('Example bundle must use portable-bundle v1');
  }
  if (typeof document.exportedAt !== 'string' || !document.exportedAt) {
    throw new Error('Example bundle exportedAt is required');
  }
  if (!Array.isArray(document.queries) || !Array.isArray(document.dashboards)) {
    throw new Error('Example bundle requires queries and dashboards arrays');
  }

  const queryIds = new Set();
  for (const query of document.queries) {
    if (!isObject(query) || typeof query.id !== 'string' || !query.id) {
      throw new Error('Every example query requires a non-empty id');
    }
    if (queryIds.has(query.id)) throw new Error(`Duplicate query id ${JSON.stringify(query.id)}`);
    queryIds.add(query.id);
    if (typeof query.sql !== 'string' || query.specVersion !== 1 || !isObject(query.spec)) {
      throw new Error(`Query ${JSON.stringify(query.id)} must use saved-query Spec v1`);
    }
    if (query.spec.panel && !query.spec.panel?.cfg?.type) {
      throw new Error(`Query ${JSON.stringify(query.id)} panel requires cfg.type`);
    }
  }

  const dashboardIds = new Set();
  for (const dashboard of document.dashboards) {
    if (!isObject(dashboard) || dashboard.documentVersion !== 1 || !dashboard.id) {
      throw new Error('Every example dashboard must use documentVersion 1 and a non-empty id');
    }
    if (dashboardIds.has(dashboard.id)) throw new Error(`Duplicate dashboard id ${JSON.stringify(dashboard.id)}`);
    dashboardIds.add(dashboard.id);
    if (!Array.isArray(dashboard.tiles) || !Array.isArray(dashboard.filters)) {
      throw new Error(`Dashboard ${JSON.stringify(dashboard.id)} requires tiles and filters arrays`);
    }
    const layout = dashboard.layout;
    const supportedLayout = layout?.version === 1
      && (layout.type === 'flow' || layout.type === 'grafana-grid');
    if (!supportedLayout) {
      throw new Error(`Dashboard ${JSON.stringify(dashboard.id)} must use flow@1 or grafana-grid@1`);
    }
    if (layout.type === 'grafana-grid'
      && (layout.fallback?.type !== 'flow' || layout.fallback?.version !== 1)) {
      throw new Error(`Dashboard ${JSON.stringify(dashboard.id)} grafana-grid@1 layout requires a flow@1 fallback`);
    }
    for (const tile of dashboard.tiles) {
      if (!queryIds.has(tile.queryId)) {
        throw new Error(`Dashboard ${JSON.stringify(dashboard.id)} references unknown query ${JSON.stringify(tile.queryId)}`);
      }
      const query = document.queries.find((item) => item.id === tile.queryId);
      if (queryDashboardRole(query) !== 'panel') {
        throw new Error(`Dashboard tile ${JSON.stringify(tile.id)} must reference a Panel query`);
      }
    }
    for (const filter of dashboard.filters) {
      if (filter.sourceQueryId && !queryIds.has(filter.sourceQueryId)) {
        throw new Error(`Filter ${JSON.stringify(filter.id)} references unknown source query`);
      }
    }
  }
  return document;
}

export function serializeExampleBundle({ exportedAt, metadata, queries, dashboards }) {
  const normalizedQueries = normalizeQueriesForDashboards(queries, dashboards);
  const document = {
    $schema: PORTABLE_BUNDLE_SCHEMA,
    format: PORTABLE_BUNDLE_FORMAT,
    version: 1,
    exportedAt,
    ...(metadata ? { metadata } : {}),
    queries: normalizedQueries,
    dashboards: clone(dashboards),
  };
  assertValidExampleBundle(document);
  return JSON.stringify(document, null, 2) + '\n';
}

export function writeExampleBundle(path, input) {
  const encoded = serializeExampleBundle(input);
  writeFileSync(path, encoded);
  return encoded;
}
