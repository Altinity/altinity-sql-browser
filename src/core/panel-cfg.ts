// The panel-config union (#166). Pure logic — no DOM, no globals. A saved
// query's `panel: { cfg, key? }` names an explicit visualization:
//
//   cfg.type ∈ bar|hbar|line|area|pie   (chart family — exactly the chart-data
//                                        cfg shape: column indices + panel.key)
//            | table                     (no schema-bound fields)
//            | logs                      ({time?,msg?,level?} column NAMES)
//            | text                      ({content} — needs no result at all)
//
// Field policy (pinned in #166): unknown cfg fields are ignored by validation
// and *preserved* by clone/normalize — the additive forward-compatibility
// mechanism (a newer build's fields survive an older build's edit, and the
// `view:'table'`-with-latent-chart migration stashes the old chart roles as an
// extra `chart` field this arm never reads). Unknown *types* are preserved in
// storage too; rendering falls back via `resolvePanel` with a diagnostic.

import type {
  AreaPanelCfg, BarPanelCfg, FieldConfig, HbarPanelCfg, KpiPanelCfg, LinePanelCfg,
  LogsPanelCfg, Panel, PanelCfg, PiePanelCfg, TablePanelCfg, TextPanelCfg,
} from '../generated/json-schema.types.js';
import {
  autoChart as _autoChart, chartCfgValid as _chartCfgValid,
  normalizeChartCfg as _normalizeChartCfg, schemaKey as _schemaKey, CHART_TYPES as _CHART_TYPES,
} from './chart-data.js';
import {
  detectLogsView as _detectLogsView, findTimeColumn as _findTimeColumn,
  findMsgColumn as _findMsgColumn, findLevelColumn as _findLevelColumn,
} from './logs.js';
import { cloneJson } from './saved-query.js';
import { querySpecSchemaService as _querySpecSchemaService } from './spec-schema.js';
import { readKpiFields as _readKpiFields } from './kpi.js';

/** A ClickHouse result column as every panel-cfg helper reads it (extra
 *  metadata may ride along on the live streaming result). */
export interface Column {
  name: string;
  type: string;
  [k: string]: unknown;
}

// The chart-family PanelCfg branches — literal `type` ids derived from the
// generated schema branches themselves (no hand-duplicated literal list).
type ChartFamilyCfg = BarPanelCfg | HbarPanelCfg | LinePanelCfg | AreaPanelCfg | PiePanelCfg;
export type ChartFamilyType = ChartFamilyCfg['type'];
type KnownPanelCfg = ChartFamilyCfg | KpiPanelCfg | TablePanelCfg | LogsPanelCfg | TextPanelCfg;
export type KnownPanelTypeId = KnownPanelCfg['type'];

// chart-data.js is unconverted (checkJs:false), so TS infers its exports'
// shapes structurally from the JS body rather than trusting these hand-written
// contracts — wrapper casts pin the honest shape this file relies on: CHART_TYPES'
// `value` is exactly one of the five chart PanelCfg type literals, and
// autoChart/chartCfgValid/normalizeChartCfg all operate on that same closed
// chart-cfg shape (verified against the wrapped function bodies).
const CHART_TYPES = _CHART_TYPES as { value: ChartFamilyType; label: string }[];
const autoChart = _autoChart as (columns: Column[] | null | undefined) => ChartFamilyCfg | null;
const chartCfgValid = _chartCfgValid as
  (cfg: unknown, columns: Column[] | null | undefined) => cfg is ChartFamilyCfg;
const normalizeChartCfg = _normalizeChartCfg as
  <T extends Record<string, unknown> | null | undefined>(cfg: T) => T;
const schemaKey = _schemaKey as (columns: Column[] | null | undefined) => string;

/** The chart-family type ids (share the chart-data cfg shape + `panel.key`). */
export const CHART_FAMILY: Set<ChartFamilyType> = new Set(CHART_TYPES.map((t) => t.value));

/** Every v1 panel type id, in picker order (chart family first). */
export const PANEL_TYPE_IDS: KnownPanelTypeId[] = ['kpi', ...CHART_FAMILY, 'table', 'logs', 'text'];

const KNOWN_TYPES: Set<KnownPanelTypeId> = new Set(PANEL_TYPE_IDS);

/** True when `type` is one of the chart-family arms. */
export function isChartFamily(type: unknown): type is ChartFamilyType {
  // Ingress: `type` may be any saved/hand-edited value; membership in the
  // known Set is exactly the runtime proof that the cast below is honest.
  return typeof type === 'string' && CHART_FAMILY.has(type as ChartFamilyType);
}

/** True when `type` is any known v1 panel type. */
export function isKnownPanelType(type: unknown): type is KnownPanelTypeId {
  return typeof type === 'string' && KNOWN_TYPES.has(type as KnownPanelTypeId);
}

// Panel types that need no query result at all — the one per-arm capability
// every layer keys the "no SQL required / no query issued" behavior on (save
// guard, share gate, dashboard partition, drawer preview). Dashboard roles
// such as Filter/Setup are deliberately not panel arms and never join it.
const QUERYLESS_TYPES = new Set<string>(['text']);

/** True when a panel payload's type renders without a query result (#166). */
export function isQuerylessPanel(panel?: Panel | null): boolean {
  return !!(panel && panel.cfg && QUERYLESS_TYPES.has(panel.cfg.type));
}

/**
 * Deep-clone a panel cfg so a restored config never aliases its saved source
 * (editing the live panel must not mutate the Library entry). Unknown fields
 * ride along untouched. null/undefined → null.
 */
export function clonePanelCfg(cfg: unknown): PanelCfg | null {
  // Ingress: a saved/URL-hash panel cfg is arbitrary caller/storage JSON —
  // only object-shape checked here (same convention as saved-query.ts's
  // queryPanel/queryDashboard ingress casts); full validation is
  // panelCfgStaticValid's job, not this clone's.
  return cfg && typeof cfg === 'object' ? cloneJson(cfg as PanelCfg) : null;
}

/** The `{time,msg,level|null,extras}` column-index shape renderLogs consumes. */
export interface LogsShape {
  time: number;
  msg: number;
  level: number | null;
  extras: number[];
}

// The logs arm's name-role fields, widened to `unknown` + an index signature:
// callers pass either a real LogsPanelCfg or a still-unknown FuturePanelCfg
// (TS can't exclude FuturePanelCfg from a `cfg.type === 'logs'` narrow — see
// its doc comment in the generated types — so this file's `type`-dispatch
// branches carry a `LogsPanelCfg | FuturePanelCfg`-shaped value through here).
type LogsCfgLike = { time?: unknown; msg?: unknown; level?: unknown; [k: string]: unknown };

const findTimeColumn = _findTimeColumn as (columns: Column[] | null | undefined) => number;
const findMsgColumn = _findMsgColumn as (columns: Column[] | null | undefined) => number;
const findLevelColumn = _findLevelColumn as (columns: Column[] | null | undefined) => number;
const detectLogsView = _detectLogsView as (columns: Column[] | null | undefined) => LogsShape | null;

/**
 * Resolve a logs cfg's `{time, msg, level}` column NAMES against the result
 * columns (case-insensitive — matching detectLogsView's convention). Explicit
 * names are authoritative: if `time` or `msg` is present but doesn't resolve,
 * the lookup fails (returns null) — a failed name lookup IS the logs arm's
 * schema-mismatch signal (#166; there is no `key` for name-based roles).
 * Names the cfg omits fall back to convention detection for that role.
 * Returns the same `{time, msg, level|null, extras}` index shape renderLogs
 * consumes, or null when no usable time+msg pair resolves.
 */
export function resolveLogsShape(cfg: LogsCfgLike, columns: Column[] | null | undefined): LogsShape | null {
  const cols = columns || [];
  const idxOf = (name: unknown) => cols.findIndex((c) => String(c.name).toLowerCase() === String(name).toLowerCase());
  // Per-role fallback: an omitted name uses that role's own convention scan —
  // an explicit `msg` may point at a column detection would never pick, while
  // the time column is still found by convention (and vice versa).
  const pick = (explicit: unknown, fallbackIdx: number): number | null => {
    if (explicit == null || explicit === '') return fallbackIdx < 0 ? null : fallbackIdx;
    const i = idxOf(explicit);
    return i < 0 ? null : i;
  };
  const time = pick(cfg.time, findTimeColumn(cols));
  const msg = pick(cfg.msg, findMsgColumn(cols));
  if (time == null || msg == null) return null;
  // A dangling explicit level degrades to "no level column" (colors off) —
  // unlike time/msg it isn't load-bearing, so it shouldn't fail the panel.
  const level = pick(cfg.level, findLevelColumn(cols));
  const extras = cols.map((_, i) => i).filter((i) => i !== time && i !== msg && i !== level);
  return { time, msg, level, extras };
}

/** The schema-diagnostic shape this file reads from `querySpecSchemaService`
 *  (narrowed to exactly the fields consulted here — see json-schema-validation.js). */
interface SchemaDiagnostic {
  severity: string;
  path: (string | number)[];
  [k: string]: unknown;
}
interface SpecSchemaService {
  validate(value: unknown): SchemaDiagnostic[];
}
// spec-schema.js is unconverted; querySpecSchemaService's `validate` returns
// exactly the normalizeJsonSchemaErrors diagnostic shape (json-schema-validation.js).
const querySpecSchemaService = _querySpecSchemaService as SpecSchemaService;

/**
 * Is `cfg` structurally valid *for this result's columns*? Per arm:
 * chart family → chart-data's index validation; logs → the name lookups
 * resolve; table → always (no schema-bound fields); text → always (needs no
 * result). Unknown/missing type → false (rendering falls back via
 * resolvePanel). Unknown extra fields are ignored, never a failure.
 */
export function panelCfgStaticValid(cfg: unknown, schemaService: SpecSchemaService = querySpecSchemaService): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  return !schemaService.validate({ panel: { cfg } })
    .some((diagnostic) => diagnostic.severity === 'error'
      && diagnostic.path[0] === 'panel' && diagnostic.path[1] === 'cfg');
}

export function panelCfgValid(
  cfg: unknown,
  columns: Column[] | null | undefined,
  schemaService: SpecSchemaService = querySpecSchemaService,
): boolean {
  if (!cfg || typeof cfg !== 'object') return false;
  if (!panelCfgStaticValid(cfg, schemaService)) return false;
  // Ingress: `cfg` is only object-shape + schema checked above — its `type`
  // is read as `unknown` until one of the per-arm branches below confirms it.
  const type = (cfg as { type?: unknown }).type;
  if (isChartFamily(type)) return chartCfgValid(cfg, columns);
  if (type === 'logs') return resolveLogsShape(cfg as LogsCfgLike, columns) != null;
  return type === 'kpi' || type === 'table' || type === 'text';
}

/**
 * Fold an arm's cross-field invariants on a (cloned) cfg, preserving unknown
 * fields: chart family → normalizeChartCfg (pie single-measure, series ≠ X);
 * text → `content` coerced to a string. Mutates and returns `cfg` (null →
 * null), mirroring normalizeChartCfg's contract.
 */
export function normalizePanelCfg(cfg: PanelCfg | null | undefined): PanelCfg | null | undefined {
  if (!cfg) return cfg;
  if (isChartFamily(cfg.type)) return normalizeChartCfg(cfg);
  if (cfg.type === 'text' && typeof cfg.content !== 'string') cfg.content = '';
  return cfg;
}

// Re-derive chart roles for an explicitly-kept chart type after a schema
// change: autoChart picks fresh axes, the saved type stays (that's the user's
// explicit intent), and normalize folds the type's invariants back in.
// Null when the new result has nothing plottable at all.
function rederiveChart(type: ChartFamilyType, columns: Column[] | null | undefined): ChartFamilyCfg | null {
  const cfg = autoChart(columns);
  if (!cfg) return null;
  cfg.type = type;
  return normalizeChartCfg(cfg);
}

/** A result (or bare column list) as autoPanel/resolvePanel accept it. */
export interface ResultLike {
  columns?: Column[];
  rows?: unknown[][] | null;
  rowCount?: number | null;
  fieldConfig?: FieldConfig;
  serverVersion?: string;
}
type PanelInput = Column[] | ResultLike | null | undefined;

interface ResultContext {
  columns: Column[];
  rows: unknown[][] | null;
  rowCount: number | null;
  fieldConfig: FieldConfig;
  serverVersion?: string;
}

/**
 * The unconfigured-result heuristic (#166) — replaces classifyTile's ladder
 * and D9's interim ranking. Ranks specific-before-generic: log-shaped →
 * `{type:'logs'}` (carrying the detected shape), chartable → autoChart's pick,
 * else `{type:'table'}`. `text` (and the later filter/setup arms) are never
 * auto-proposed — they exist only as explicit choices. Returns
 * `{ cfg, shape? }`; never null (table is the universal fallback).
 */
function resultContext(input: PanelInput): ResultContext {
  if (Array.isArray(input)) return { columns: input, rows: null, rowCount: null, fieldConfig: {} };
  const value: ResultLike = input && typeof input === 'object' ? input : {};
  const rows = Array.isArray(value.rows) ? value.rows : null;
  return {
    columns: Array.isArray(value.columns) ? value.columns : [],
    rows,
    rowCount: Number.isInteger(value.rowCount) ? (value.rowCount as number) : rows ? rows.length : null,
    fieldConfig: value.fieldConfig || {},
    serverVersion: value.serverVersion,
  };
}

/** The KPI read-out shape `readKpiFields` (kpi.js) returns — narrowed to the
 *  one field (`items.length`) this module inspects; downstream renderers read
 *  the rest directly off the same object. */
export interface KpiResult {
  items: unknown[];
  diagnostics: unknown[];
}
const readKpiFields = _readKpiFields as (args: {
  columns?: Column[];
  row?: unknown;
  rowCount?: number;
  fieldConfig?: FieldConfig;
  serverVersion?: string;
}) => KpiResult;

/** The heuristic's proposed panel — an explicit type was never asked for, so
 *  there is nothing to "resolve" against a saved choice (contrast `PanelResolution`). */
export interface AutoPanelResult {
  cfg: PanelCfg;
  shape?: LogsShape;
  kpi?: KpiResult;
}

export function autoPanel(input: PanelInput): AutoPanelResult {
  const context = resultContext(input);
  const { columns } = context;
  const shape = detectLogsView(columns);
  if (shape) return { cfg: { type: 'logs' }, shape };
  if (context.rowCount === 1) {
    const kpi = readKpiFields({
      columns, row: context.rows && context.rows[0], rowCount: 1,
      fieldConfig: context.fieldConfig, serverVersion: context.serverVersion,
    });
    if (kpi.items.length) return { cfg: { type: 'kpi' }, kpi };
  }
  const chart = autoChart(columns);
  if (chart) return { cfg: chart };
  return { cfg: { type: 'table' } };
}

/** A panel payload as switchPanelType/resolvePanel accept it: an EXPLICIT cfg
 *  (an author's chosen visualization to preserve/resolve), a cfg explicitly
 *  cleared to `null`, or an ABSENT `cfg` (no panel authored at all) — the
 *  three ingress states the Panel-type picker and Library restore both need
 *  to distinguish, one level looser than `Panel` (whose `cfg` may not be `null`). */
export interface PanelPayload {
  cfg?: PanelCfg | null;
  key?: string | null;
  [k: string]: unknown;
}
/** switchPanelType's result: always an explicit, resolved cfg + its schema key. */
export interface ResolvedPanelPayload {
  cfg: PanelCfg;
  key: string | null;
}

// The internal reshaping bag switchPanelType works through: a panel cfg is a
// closed discriminated union at rest (PanelCfg), but *switching* type is an
// in-place role-transplant across arms with forward-compatible unknown-field
// preservation — a shape no single discriminated-union member can express
// mid-transplant. This file works the transplant through the wider bag below
// and re-asserts `PanelCfg` only at each function's actual return points.
type PanelCfgBag = Record<string, unknown> & { type?: unknown };

/** The chart-role stash `switchPanelType` reads/writes on `cfg.chart` when
 *  leaving/re-entering the chart family (see the function doc below). */
interface ChartStash {
  type?: unknown;
  x?: unknown;
  y?: unknown;
  series?: unknown;
  key?: unknown;
}

/**
 * Switch a panel's type (the Panel tab's picker, #166) — pure. Returns a NEW
 * `{cfg, key}` payload; never mutates the input. Role continuity rules:
 *  - same type → the payload passes through unchanged;
 *  - chart → chart: keep the configured axes, swap the type (normalized);
 *  - leaving the chart family: the chart roles are STASHED as `cfg.chart`
 *    ({type,x,y,series,key}) — an unknown field to the target arm, preserved
 *    by the ignore-and-preserve policy — so switching back is lossless (the
 *    same shape the `view:'table'` migration writes);
 *  - entering the chart family: consume the stash when present (its axes and
 *    schema key win, the picked type overrides), else derive roles via
 *    autoChart — a non-chartable result keeps schema-valid placeholder roles
 *    so the preview can show the result-aware not-chartable hint;
 *  - text always (re)gains a string `content` ('' when absent).
 */
export function switchPanelType(
  payload: PanelPayload | null | undefined,
  type: string,
  columns: Column[],
): ResolvedPanelPayload {
  const cur: PanelPayload = payload && payload.cfg ? payload : { cfg: null };
  // clonePanelCfg's declared return type is `PanelCfg | null`, but it only
  // actually returns null for a falsy/non-object input — `cur.cfg` is
  // truthy (and object-shaped, per PanelPayload) whenever the ternary picks
  // this branch, so the cast below is exactly that already-true fact, not an
  // unchecked assumption.
  const cfg: PanelCfgBag = (cur.cfg ? clonePanelCfg(cur.cfg) : {}) as PanelCfgBag;
  if (cfg.type === type) return { cfg: cfg as PanelCfg, key: cur.key ?? null };
  const wasChart = isChartFamily(cfg.type);
  const { type: _oldType, x, y, series, chart: stash, content, ...rest } = cfg;
  const stashCfg = stash as ChartStash | undefined;
  if (isChartFamily(type)) {
    const roles = wasChart
      ? { x, y, series: series ?? null, key: cur.key ?? null }
      : stashCfg
        ? { x: stashCfg.x, y: stashCfg.y, series: stashCfg.series ?? null, key: stashCfg.key ?? null }
        : (() => { const a = autoChart(columns); return a ? { ...a, key: schemaKey(columns) } : null; })();
    if (!roles) {
      return { cfg: { ...rest, type, x: 0, y: [columns.length], series: null } as PanelCfg, key: null };
    }
    // The picked type wins LAST: an autoChart-derived `roles` carries its own
    // type pick, which must not override the user's.
    const { key, ...axes } = roles;
    return { cfg: normalizeChartCfg({ ...rest, ...axes, type }) as PanelCfg, key: (key as string | null) ?? null };
  }
  const next: PanelCfgBag = { ...rest, type };
  if (wasChart) next.chart = { type: _oldType, x, y, series: series ?? null, key: cur.key ?? null };
  else if (stash) next.chart = stash; // keep an existing stash riding along
  if (type === 'text') next.content = typeof content === 'string' ? content : '';
  else if (typeof content === 'string') next.content = content; // preserved (unknown to other arms)
  return { cfg: next as PanelCfg, key: null };
}

/** `resolvePanel`'s verdict on a saved panel against the current result: the
 *  cfg always renders as *some* valid arm, and the flags say how it got
 *  there — retained as-saved, re-derived within the same explicit type
 *  (`rederived`), or replaced by the auto heuristic (`fallback`, with a
 *  human-readable `diagnostic`). Distinguishes a resolved KPI/logs panel's
 *  extra read-out (`kpi`/`shape`) from a chart/table/text panel's absence of one. */
export interface PanelResolution {
  cfg: PanelCfg;
  shape?: LogsShape;
  kpi?: KpiResult | null;
  fieldConfig: FieldConfig;
  rederived: boolean;
  fallback: boolean;
  diagnostic?: string;
}

/**
 * Resolve a saved `panel: {cfg, key?}` against a result — the one mismatch
 * policy both surfaces share (#166): a schema change *retains the explicit
 * type and re-derives the roles within it* (chart: fresh axes for that chart
 * type; logs: convention defaults), flagged `rederived` so the UI can show a
 * small "roles re-detected" hint. Only when the explicit type is impossible
 * for this result shape (nothing plottable for a chart, no time+message for
 * logs, or an unknown type) does it fall back to `autoPanel`, with a
 * `diagnostic`. The returned cfg is always a normalized clone — never an
 * alias of the saved entry — with unknown fields preserved.
 *
 * Returns { cfg, shape?, rederived, fallback, diagnostic? }.
 */
export function resolvePanel(saved: Panel | null | undefined, input: PanelInput): PanelResolution {
  const context = resultContext(input);
  const { columns } = context;
  const fieldConfig = saved?.fieldConfig || context.fieldConfig;
  const resolved = (value: Omit<PanelResolution, 'fieldConfig'>): PanelResolution => ({ ...value, fieldConfig });
  const savedCfg = saved && saved.cfg && typeof saved.cfg === 'object' ? saved.cfg : null;
  const fallbackTo = (diagnostic: string): PanelResolution =>
    resolved({ ...autoPanel(context), rederived: false, fallback: true, diagnostic });
  if (!savedCfg) return resolved({ ...autoPanel(context), rederived: false, fallback: false });
  if (!panelCfgStaticValid(savedCfg)) {
    return fallbackTo('Saved panel has invalid static configuration.');
  }
  // Non-null: normalizePanelCfg only returns null/undefined for a falsy input,
  // and clonePanelCfg(savedCfg) is truthy here (savedCfg passed the object check above).
  const cfg = normalizePanelCfg(clonePanelCfg(savedCfg)) as PanelCfg;
  if (cfg.type === 'kpi') {
    const kpi = context.rowCount == null ? null : readKpiFields({
      columns, row: context.rows && context.rows[0], rowCount: context.rowCount,
      fieldConfig, serverVersion: context.serverVersion,
    });
    return resolved({ cfg, kpi, rederived: false, fallback: false });
  }
  if (isChartFamily(cfg.type)) {
    // An explicit key mismatch means the column positions no longer carry the
    // saved roles, even if every old index remains in range (columns may have
    // reordered). Retain the requested chart type but derive fresh axes.
    const keyMismatch = saved?.key != null && saved.key !== schemaKey(columns);
    if (chartCfgValid(cfg, columns) && !keyMismatch) return resolved({ cfg, rederived: false, fallback: false });
    const red = rederiveChart(cfg.type, columns);
    if (red) return resolved({ cfg: { ...cfg, ...red, type: cfg.type } as PanelCfg, rederived: true, fallback: false });
    return fallbackTo('Saved ' + cfg.type + ' chart has nothing to plot in this result.');
  }
  if (cfg.type === 'logs') {
    const explicit = resolveLogsShape(cfg as LogsCfgLike, columns);
    if (explicit) return resolved({ cfg, shape: explicit, rederived: false, fallback: false });
    // A failed explicit-name lookup is the logs arm's mismatch signal: retain
    // the type and re-derive the roles by convention (the mismatch policy).
    const detected = detectLogsView(columns);
    if (detected) return resolved({ cfg, shape: detected, rederived: true, fallback: false });
    return fallbackTo('Saved logs panel: no time + message columns in this result.');
  }
  if (cfg.type === 'table' || cfg.type === 'text') {
    return resolved({ cfg, rederived: false, fallback: false });
  }
  return fallbackTo('Unknown panel type "' + String(cfg.type) + '" (saved by a newer build?).');
}
