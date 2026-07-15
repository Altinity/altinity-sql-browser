// Canonical saved-query model (format-v2 query entries). Pure: no DOM/globals.
//
// Application-managed fields stay at the query root:
//   { id, sql, specVersion, spec }
// Everything users may author or extend lives in `spec`. Spec is JSON-shaped;
// every helper clones recursively so reads followed by edits cannot alias the
// Library entry and unknown objects/arrays survive every known-field patch.

export const SPEC_VERSION = 1;

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function defineJsonField(target, key, value) {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

/** Deep-clone a JSON-shaped value, retaining unknown fields and array order. */
export function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // defineProperty avoids invoking Object.prototype.__proto__ while still
      // retaining that JSON key as ordinary forward-compatible data.
      defineJsonField(out, key, cloneJson(item));
    }
    return out;
  }
  return value;
}

export function queryName(query) {
  const value = query && query.spec && query.spec.name;
  return typeof value === 'string' && value.trim() ? value : 'Untitled';
}

export function queryDescription(query) {
  const value = query && query.spec && query.spec.description;
  return typeof value === 'string' ? value : '';
}

export function queryFavorite(query) {
  return !!(query && query.spec && query.spec.favorite === true);
}

export function queryView(query) {
  const value = query && query.spec && query.spec.view;
  return typeof value === 'string' ? value : undefined;
}

export function queryPanel(query) {
  const value = query && query.spec && query.spec.panel;
  return isPlainObject(value) ? value : undefined;
}

export function queryDashboard(query) {
  const value = query && query.spec && query.spec.dashboard;
  return isPlainObject(value) ? value : undefined;
}

/** Return a canonical cloned query with `nextSpec` as its complete Spec. */
export function withQuerySpec(query, nextSpec) {
  return {
    id: query && query.id,
    sql: typeof (query && query.sql) === 'string' ? query.sql : '',
    specVersion: SPEC_VERSION,
    spec: cloneJson(isPlainObject(nextSpec) ? nextSpec : {}),
  };
}

/** Patch top-level Spec fields. An `undefined` value deletes that field. */
export function patchQuerySpec(query, patch) {
  const spec = cloneJson(isPlainObject(query && query.spec) ? query.spec : {});
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === undefined) delete spec[key];
    else defineJsonField(spec, key, cloneJson(value));
  }
  return withQuerySpec(query, spec);
}

/**
 * Patch the complete `spec.panel` object without stripping future siblings
 * (`fieldConfig`, `transformations`, `links`, ...). `null` removes the whole
 * panel; an undefined patch value removes only that panel field.
 */
export function patchQueryPanel(query, patch) {
  if (patch === null) return patchQuerySpec(query, { panel: undefined });
  const panel = cloneJson(queryPanel(query) || {});
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === undefined) delete panel[key];
    else defineJsonField(panel, key, cloneJson(value));
  }
  return patchQuerySpec(query, { panel });
}

/**
 * Patch the complete `spec.dashboard` object while retaining extension fields.
 * `null` removes the object; an undefined patch value removes only that field.
 */
export function patchQueryDashboard(query, patch) {
  if (patch === null) return patchQuerySpec(query, { dashboard: undefined });
  const dashboard = cloneJson(queryDashboard(query) || {});
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === undefined) delete dashboard[key];
    else defineJsonField(dashboard, key, cloneJson(value));
  }
  return patchQuerySpec(query, { dashboard });
}

const cleanLegacyPanel = (value) =>
  (isPlainObject(value) && isPlainObject(value.cfg) ? cloneJson(value) : undefined);
const cleanLegacyChart = cleanLegacyPanel;
const cleanLegacyView = (value) =>
  (value === 'table' || value === 'json' || value === 'panel' || value === 'chart' ? value : undefined);

/** Upgrade one supported flat-v1 query without mutating it. */
export function upgradeV1Query(entry) {
  const raw = isPlainObject(entry) ? entry : {};
  const chart = cleanLegacyChart(raw.chart);
  let panel = cleanLegacyPanel(raw.panel);
  let view = cleanLegacyView(raw.view);

  // #166 compatibility precedence is authoritative. A real panel wins over
  // the stale chart mirror. Otherwise a table view stashes chart roles; a
  // normal chart becomes the panel payload. Legacy `chart` never enters Spec.
  if (!panel && chart) {
    if (view === 'table') {
      panel = { cfg: { type: 'table', chart: { ...cloneJson(chart.cfg), key: chart.key ?? null } } };
    } else {
      // Match the live save path (panels.js writePanel): a null schema key is
      // OMITTED, never stored as `key: null`. Emitting an explicit null here
      // would make queryContentKey see `{cfg, key:null}` ≠ a live `{cfg}`, so
      // a v1-origin chart and its identical v2-live twin would fail to dedup
      // on merge/append (spurious duplicate). resolvePanel treats absent and
      // null identically (`saved.key != null`), so omission is lossless.
      panel = chart.key != null
        ? { cfg: cloneJson(chart.cfg), key: chart.key }
        : { cfg: cloneJson(chart.cfg) };
    }
  }
  if (view === 'chart') view = 'panel';

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled';
  const spec = { name, favorite: !!raw.favorite };
  if (typeof raw.description === 'string' && raw.description.trim()) spec.description = raw.description.trim();
  if (view) spec.view = view;
  if (panel) spec.panel = panel;
  if (isPlainObject(raw.dashboard)) spec.dashboard = cloneJson(raw.dashboard);

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : undefined,
    sql: typeof raw.sql === 'string' ? raw.sql : '',
    specVersion: SPEC_VERSION,
    spec,
  };
}

/** Clone a structurally-supported v2 query into canonical root shape. */
export function cloneV2Query(query) {
  if (!isPlainObject(query)) throw new Error('Saved query must be an object');
  if (query.specVersion !== SPEC_VERSION) {
    throw new Error('Unsupported saved-query Spec version: ' + String(query.specVersion));
  }
  if (!isPlainObject(query.spec)) throw new Error('Saved query Spec must be an object');
  return withQuerySpec(query, query.spec);
}

/** LocalStorage/other versionless ingress: v2 clone or transparent v1 upgrade. */
export function upgradeSavedQuery(query) {
  return isPlainObject(query) && ('spec' in query || 'specVersion' in query)
    ? cloneV2Query(query)
    : upgradeV1Query(query);
}

// Stable JSON comparison: object property order is authoring trivia; array
// order remains semantic. Used for merge duplicate detection only — the actual
// Spec retains its original property order on persistence/export.
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      defineJsonField(out, key, stableValue(value[key]));
    }
    return out;
  }
  return value;
}

export function queryContentKey(query) {
  return JSON.stringify([
    typeof (query && query.sql) === 'string' ? query.sql : '',
    query && query.specVersion,
    stableValue(isPlainObject(query && query.spec) ? query.spec : {}),
  ]);
}
