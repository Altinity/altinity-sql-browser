// Canonical saved-query model (format-v2 query entries). Pure: no DOM/globals.
//
// Application-managed fields stay at the query root:
//   { id, sql, specVersion, spec }
// Everything users may author or extend lives in `spec`. Spec is JSON-shaped;
// every helper clones recursively so reads followed by edits cannot alias the
// Library entry and unknown objects/arrays survive every known-field patch.

import type { Panel, QueryDashboardPresentationV1, QuerySpecV1 } from '../generated/json-schema.types.js';

export const SPEC_VERSION = 1;

/**
 * The canonical `{id, sql, specVersion, spec}` query root these builders
 * construct and patch — structurally close to the persisted `SavedQueryV2`
 * shape but not asserted as one: `id` may be `null`/`undefined` for a query
 * not yet given a stable identifier (or when the source `query` itself was
 * falsy — see `withQuerySpec`), and `spec` is only as complete as the patches
 * applied so far. Full-shape validation happens at the
 * schemas/query-spec-v1.schema.json boundary before persistence, not here.
 */
export interface QueryRoot {
  id: string | null | undefined;
  sql: string;
  specVersion: typeof SPEC_VERSION;
  spec: QuerySpecV1;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Write one JSON-shaped key onto a plain object as an OWN enumerable,
 * writable, configurable data property, via `Object.defineProperty` rather
 * than `target[key] = value`. The difference matters for exactly one key: a
 * bare assignment to `'__proto__'` on a plain object invokes the INHERITED
 * `Object.prototype.__proto__` setter (changing `target`'s own prototype
 * instead of creating a property), so the write silently vanishes and
 * `JSON.stringify(target)` never sees it. `defineProperty` always creates an
 * own data property, so `'__proto__'`/`'constructor'` survive as ordinary
 * forward-compatible data — the same class of input `JSON.parse` already
 * produces (it special-cases object keys the same way).
 *
 * This is the one shared primitive for every write into a plain object keyed
 * by caller-controlled string data — used here for Spec/panel/dashboard
 * fields, and reused by every Dashboard placement-map write (`layout.items`)
 * across `src/dashboard/layouts` and `src/dashboard/model` (#551): a tile id
 * is exactly such caller-controlled data (schema pattern `\S`, so `__proto__`
 * and `constructor` are both legal tile ids). No prototype pollution is
 * possible either way: only `target`'s own `[[Prototype]]`/properties are
 * ever touched, never `Object.prototype` itself.
 */
export function defineJsonField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

/**
 * Read one key off a plain object as an OWN property only — `undefined` for
 * anything else. The read-side counterpart of `defineJsonField`, and not a
 * redundant safety net: a bare `target[key]` for `key === '__proto__'` (or
 * `'constructor'`) on a `target` with no OWN property under that name
 * resolves through the prototype chain to `Object.prototype` itself (or
 * `Object.prototype.constructor`) — a real object, so an `isObject(...)`
 * check alone cannot tell it apart from genuine stored data. Code that reads
 * a placement this way to MERGE-then-rewrite it (e.g. `current[style] =
 * next` while preserving `current`'s other fields) ends up assigning
 * directly onto the ALIASED `Object.prototype`, mutating it for the whole
 * realm — not a hypothetical: this is exactly how `setStylePlacement`
 * (`grafana-grid-layout.ts`) polluted `Object.prototype.grid` for every
 * OTHER placement map in the same test run until this helper replaced its
 * bare read (#551 review). Every read of a caller-keyed JSON map that could
 * be merged, mutated, or treated as "no entry vs. an empty one" must go
 * through this, not a bare bracket access.
 */
export function readJsonField(target: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(target, key) ? target[key] : undefined;
}

/**
 * JS `value && value[key]` semantics, made narrowable under `strict`: a falsy
 * `value` passes straight through unchanged (so, e.g., `withQuerySpec` keeps
 * `null`'s literal `null` for a missing query root instead of widening it to
 * `undefined`), and `key` is read only when `value` is a plain object — the
 * shape every real query root/Spec is, or explicitly isn't.
 */
function andGet(value: unknown, key: string): unknown {
  if (!value) return value;
  return isPlainObject(value) ? value[key] : undefined;
}

/** Deep-clone a JSON-shaped value, retaining unknown fields and array order.
 *  The two `as T` casts below are the generic-recursive-clone idiom: the
 *  runtime shape is provably identical to `T` (same branch, same keys), but
 *  TypeScript cannot express "this recursively rebuilt value has the same
 *  generic shape as its input" structurally. */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // defineProperty avoids invoking Object.prototype.__proto__ while still
      // retaining that JSON key as ordinary forward-compatible data.
      defineJsonField(out, key, cloneJson(item));
    }
    return out as T;
  }
  return value;
}

export function queryName(query: unknown): string {
  const value = andGet(andGet(query, 'spec'), 'name');
  return typeof value === 'string' && value.trim() ? value : 'Untitled';
}

export function queryDescription(query: unknown): string {
  const value = andGet(andGet(query, 'spec'), 'description');
  return typeof value === 'string' ? value : '';
}

export function queryFavorite(query: unknown): boolean {
  return andGet(andGet(query, 'spec'), 'favorite') === true;
}

export function queryView(query: unknown): string | undefined {
  const value = andGet(andGet(query, 'spec'), 'view');
  return typeof value === 'string' ? value : undefined;
}

export function queryPanel(query: unknown): Panel | undefined {
  const value = andGet(andGet(query, 'spec'), 'panel');
  // Ingress: `spec.panel` is read from stored/legacy/caller-supplied JSON and
  // only isPlainObject-checked here — full Panel-shape validation is
  // schemas/query-spec-v1.schema.json's job, not this pure accessor's.
  return isPlainObject(value) ? (value as Panel) : undefined;
}

export function queryDashboard(query: unknown): QueryDashboardPresentationV1 | undefined {
  const value = andGet(andGet(query, 'spec'), 'dashboard');
  // Ingress — see queryPanel's comment; same only-isPlainObject-checked read.
  return isPlainObject(value) ? (value as QueryDashboardPresentationV1) : undefined;
}

/** Return a canonical cloned query with `nextSpec` as its complete Spec. */
export function withQuerySpec(query: unknown, nextSpec: unknown): QueryRoot {
  const sql = andGet(query, 'sql');
  return {
    // Ingress: `query` is an arbitrary caller-supplied query root (or
    // null/undefined); `id` is passed through whatever shape it already has.
    id: andGet(query, 'id') as string | null | undefined,
    sql: typeof sql === 'string' ? sql : '',
    specVersion: SPEC_VERSION,
    spec: cloneJson(isPlainObject(nextSpec) ? nextSpec : {}) as QuerySpecV1,
  };
}

/** Patch top-level Spec fields. An `undefined` value deletes that field. */
export function patchQuerySpec(query: unknown, patch: unknown): QueryRoot {
  const specSrc = andGet(query, 'spec');
  const spec: Record<string, unknown> = cloneJson(isPlainObject(specSrc) ? specSrc : {});
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
export function patchQueryPanel(query: unknown, patch: unknown): QueryRoot {
  if (patch === null) return patchQuerySpec(query, { panel: undefined });
  const panel: Record<string, unknown> = cloneJson(queryPanel(query) || {});
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
export function patchQueryDashboard(query: unknown, patch: unknown): QueryRoot {
  if (patch === null) return patchQuerySpec(query, { dashboard: undefined });
  const dashboard: Record<string, unknown> = cloneJson(queryDashboard(query) || {});
  for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
    if (value === undefined) delete dashboard[key];
    else defineJsonField(dashboard, key, cloneJson(value));
  }
  return patchQuerySpec(query, { dashboard });
}

// A validated flat-v1 `chart`/`panel` mirror: an object whose `cfg` is itself
// a plain object (the one shape `cleanLegacyPanel`/`cleanLegacyChart` accept).
interface LegacyPanel {
  cfg: Record<string, unknown>;
  key?: unknown;
  [k: string]: unknown;
}
function isLegacyPanel(value: unknown): value is LegacyPanel {
  return isPlainObject(value) && isPlainObject(value.cfg);
}
const cleanLegacyPanel = (value: unknown): LegacyPanel | undefined =>
  (isLegacyPanel(value) ? cloneJson(value) : undefined);
const cleanLegacyChart = cleanLegacyPanel;
const cleanLegacyView = (value: unknown): 'table' | 'json' | 'panel' | 'chart' | undefined =>
  (value === 'table' || value === 'json' || value === 'panel' || value === 'chart' ? value : undefined);

/** Upgrade one supported flat-v1 query without mutating it. */
export function upgradeV1Query(entry: unknown): QueryRoot {
  const raw: Record<string, unknown> = isPlainObject(entry) ? entry : {};
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
  const spec: Record<string, unknown> = { name, favorite: !!raw.favorite };
  if (typeof raw.description === 'string' && raw.description.trim()) spec.description = raw.description.trim();
  if (view) spec.view = view;
  if (panel) spec.panel = panel;
  if (isPlainObject(raw.dashboard)) spec.dashboard = cloneJson(raw.dashboard);

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : undefined,
    sql: typeof raw.sql === 'string' ? raw.sql : '',
    specVersion: SPEC_VERSION,
    // Ingress: built field-by-field from conditionally-validated legacy v1
    // JSON; shape matches QuerySpecV1 by construction but isn't re-validated
    // against the schema here (that happens at the persistence boundary).
    spec: spec as QuerySpecV1,
  };
}

/** Clone a structurally-supported v2 query into canonical root shape. */
export function cloneV2Query(query: unknown): QueryRoot {
  if (!isPlainObject(query)) throw new Error('Saved query must be an object');
  if (query.specVersion !== SPEC_VERSION) {
    throw new Error('Unsupported saved-query Spec version: ' + String(query.specVersion));
  }
  if (!isPlainObject(query.spec)) throw new Error('Saved query Spec must be an object');
  return withQuerySpec(query, query.spec);
}

/** LocalStorage/other versionless ingress: v2 clone or transparent v1 upgrade. */
export function upgradeSavedQuery(query: unknown): QueryRoot {
  return isPlainObject(query) && ('spec' in query || 'specVersion' in query)
    ? cloneV2Query(query)
    : upgradeV1Query(query);
}

// Stable JSON comparison: object property order is authoring trivia; array
// order remains semantic. Used for merge duplicate detection only — the actual
// Spec retains its original property order on persistence/export.
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      defineJsonField(out, key, stableValue(value[key]));
    }
    return out;
  }
  return value;
}

export function queryContentKey(query: unknown): string {
  const sql = andGet(query, 'sql');
  const spec = andGet(query, 'spec');
  return JSON.stringify([
    typeof sql === 'string' ? sql : '',
    andGet(query, 'specVersion'),
    stableValue(isPlainObject(spec) ? spec : {}),
  ]);
}
