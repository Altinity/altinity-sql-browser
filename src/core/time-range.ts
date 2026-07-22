// Dashboard time-range control (#335) — pure validation and grouping support
// for the authoritative saved-query metadata introduced by #334. It (a)
// gates a candidate pair into a `DashboardTimeRangeGroup` only when BOTH
// filters resolve to a scalar, date-like consumer contract (reusing
// `filter-selection.ts`'s #189 consumer-resolution machinery rather than
// re-deriving it), (c) validates a staged From/To draft against the shared
// relative/absolute grammar (`relative-time.ts`), and (d) maintains the
// session-scoped "Recently used" list. No DOM, no globals, no fetch — `nowMs`
// is always injected (the repo's keystroke rule).
//
// Pair discovery remains a seam (`resolveTimeRangeGroups`'s optional `pairs`
// argument); runtime callers derive those pairs from saved-query `timeRanges`
// metadata without coupling that persistence concern to the validation logic.
//
// Group formation never mutates anything — it's a pure re-derivation over the
// dashboard's current filter defs, analysis, and executable-tile set, exactly
// like `resolveFilterSelection` itself.

import { resolveFilterSelection } from './filter-selection.js';
import type { FilterSelectionFilterDef } from './filter-selection.js';
import type { ParameterAnalysis } from './param-pipeline.js';
import type { ParsedParamType } from './param-type.js';
import { dateTimeTimeZone, isSupportedTimeRangeParamType, parseParamType } from './param-type.js';
import {
  parseRelativeExpr,
  resolveInstant,
  formatPreviewInstant,
  formatTimeParamValue,
  parseAbsoluteInstant,
  isDateLikeType,
} from './relative-time.js';
import type { ParseRelativeResult, RelativeExprError } from './relative-time.js';

// A local discriminant for `ParseRelativeResult`, mirroring `relative-time.ts`'s
// own private `isParseError` (not itself exported — a narrow, non-parsing type
// predicate is fine to have twice; the GRAMMAR it discriminates over is not
// duplicated anywhere). Needed because `RelativeExprError.error` is typed
// `string` while `ParsedRelativeExpr.error` is typed `undefined` — an inline
// `typeof` check narrows the local binding but a named predicate keeps
// `resolveBound` below readable.
function isRelativeParseError(r: ParseRelativeResult): r is RelativeExprError {
  return r != null && typeof r.error === 'string';
}

// ── Group model ──────────────────────────────────────────────────────────

/**
 * One resolved time-range group: a pair of dashboard filters whose agreed
 * consumer contracts are both scalar and date-like. `key` is derived purely
 * from the two filters' own ids (never labels, never array index) so it's
 * stable across a group list re-render as long as the underlying filter ids
 * don't change.
 */
export interface DashboardTimeRangeGroup {
  key: string;
  fromFilterId: string;
  toFilterId: string;
  fromParameter: string;
  toParameter: string;
  fromType: ParsedParamType;
  toType: ParsedParamType;
  /** Every Dashboard tile whose saved query authoritatively declares this
   * pair, irrespective of panel family. */
  tileIds: string[];
  /** Live-compatible charts are registered by the Dashboard interaction
   * controller after real result columns/scales exist. */
  interactiveChartTileIds: string[];
}

export interface TimeRangeGroupDiagnostic {
  tileId: string;
  queryId: string;
  code: 'time-range-filter-unresolved' | 'time-range-contract-invalid';
  message: string;
}

/** One candidate pair of filter ids — `inferTimeRangePairs`'s output, and the
 *  shape #334's saved-query-metadata resolution will eventually produce in
 *  its place (same seam, see this module's header comment). */
export interface TimeRangePairCandidate {
  fromFilterId: string;
  toFilterId: string;
}

// #334's interim recognized name-pair table (case-insensitive exact match on
// the FULL parameter name — never a prefix/substring match). Order here is
// also the emission order when more than one row matches distinct filters.
// `start`/`stop` is deliberately NOT a recognized pair (owner decision).
const NAME_PAIR_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['from', 'to'],
  ['from_time', 'to_time'],
  ['start', 'end'],
  ['start_time', 'end_time'],
];

/**
 * Interim pair-discovery source (#334's table): infer From/To candidate pairs
 * from the dashboard's filter parameter names alone, with no notion of
 * consumer contracts yet (that's `resolveTimeRangeGroups`'s job). Rules:
 *  - a filter with a non-null `sourceQueryId` (curated/source-backed) is
 *    NEVER a candidate — filtered out before any name matching;
 *  - matching is case-insensitive but exact (the whole parameter name, not a
 *    substring) against `NAME_PAIR_TABLE`;
 *  - a parameter name borne by MORE THAN ONE (non-curated) filter def is
 *    unusable — any pair that would need it does not form, for either role;
 *  - a filter id may appear in at most one emitted pair; if the name-pair
 *    table would place one filter in two candidate pairs, EVERY pair
 *    involving that filter is dropped (ambiguity → no group, not a guess at
 *    which pair "wins").
 * Pure.
 */
export function inferTimeRangePairs(
  filters: ReadonlyArray<{ id: string; parameter: string; sourceQueryId?: string | null }>,
): TimeRangePairCandidate[] {
  const eligible = filters.filter((f) => f.sourceQueryId == null);

  // Group eligible filters by lowercased parameter name so a name borne by
  // more than one filter can be recognized as unusable.
  const byName = new Map<string, string[]>();
  for (const f of eligible) {
    const key = f.parameter.toLowerCase();
    const ids = byName.get(key) || [];
    ids.push(f.id);
    byName.set(key, ids);
  }
  const soleIdFor = (name: string): string | null => {
    const ids = byName.get(name);
    return ids && ids.length === 1 ? ids[0] : null;
  };

  const raw: TimeRangePairCandidate[] = [];
  for (const [fromName, toName] of NAME_PAIR_TABLE) {
    const fromFilterId = soleIdFor(fromName);
    const toFilterId = soleIdFor(toName);
    if (fromFilterId && toFilterId) raw.push({ fromFilterId, toFilterId });
  }

  // Ambiguity guard: a filter id appearing in more than one raw candidate
  // (across either role) invalidates every candidate it appears in.
  const usageCount = new Map<string, number>();
  for (const pair of raw) {
    usageCount.set(pair.fromFilterId, (usageCount.get(pair.fromFilterId) || 0) + 1);
    usageCount.set(pair.toFilterId, (usageCount.get(pair.toFilterId) || 0) + 1);
  }
  return raw.filter((pair) => usageCount.get(pair.fromFilterId) === 1 && usageCount.get(pair.toFilterId) === 1);
}

/**
 * Gate candidate pairs into resolved `DashboardTimeRangeGroup`s. `pairs`
 * defaults to `inferTimeRangePairs(input.filters)` — the seam #334's metadata
 * resolution will supply instead, without this gating logic changing. A pair
 * forms a group ONLY when BOTH filters resolve via `resolveFilterSelection`
 * with zero diagnostics, a non-null contract, `contract.array === false`, and
 * `isSupportedTimeRangeParamType(contract.type)` — a filter missing from `input.filters`
 * (only possible when a caller supplies its own `pairs`) is skipped rather
 * than throwing. Emitted in `pairs`' own order. Pure — never mutates
 * `input.filters`/`input.analysis`.
 */
export function resolveTimeRangeGroups(input: {
  filters: ReadonlyArray<FilterSelectionFilterDef & { sourceQueryId?: string | null }>;
  analysis: ParameterAnalysis;
  executableTileIds: ReadonlySet<string>;
  pairs?: TimeRangePairCandidate[];
}): DashboardTimeRangeGroup[] {
  const { filters, analysis, executableTileIds } = input;
  const byId = new Map(filters.map((f) => [f.id, f] as const));
  const pairs = input.pairs ?? inferTimeRangePairs(filters);

  const groups: DashboardTimeRangeGroup[] = [];
  for (const pair of pairs) {
    const fromFilter = byId.get(pair.fromFilterId);
    const toFilter = byId.get(pair.toFilterId);
    if (!fromFilter || !toFilter) continue;

    const fromRes = resolveFilterSelection(fromFilter, analysis, executableTileIds);
    const toRes = resolveFilterSelection(toFilter, analysis, executableTileIds);
    if (fromRes.diagnostics.length || toRes.diagnostics.length || !fromRes.contract || !toRes.contract) continue;
    if (fromRes.contract.array || toRes.contract.array) continue;
    if (!isSupportedTimeRangeParamType(fromRes.contract.type.raw)
      || !isSupportedTimeRangeParamType(toRes.contract.type.raw)) continue;

    groups.push({
      key: `${fromFilter.id}\u0000${toFilter.id}`,
      fromFilterId: fromFilter.id,
      toFilterId: toFilter.id,
      fromParameter: fromFilter.parameter,
      toParameter: toFilter.parameter,
      fromType: fromRes.contract.type,
      toType: toRes.contract.type,
      tileIds: [],
      interactiveChartTileIds: [],
    });
  }
  return groups;
}

/** Resolve saved-query time-range metadata to Dashboard filter identities,
 * then aggregate every participating tile by that ordered identity pair.
 * Queries created before `timeRanges` existed retain #335's conservative
 * load-time name inference; an authored empty array is the explicit opt-out,
 * while a non-empty authored value remains authoritative. Filter targeting is
 * supplied by the viewer session's single authoritative resolver; this core
 * function never reimplements target semantics. */
export function resolveAuthoredTimeRangeGroups(input: {
  filters: ReadonlyArray<FilterSelectionFilterDef & { sourceQueryId?: string | null }>;
  analysis: ParameterAnalysis;
  executableTileIds: ReadonlySet<string>;
  filterTargetTileIds: ReadonlyMap<string, ReadonlySet<string>>;
  tiles: ReadonlyArray<{ id: string; queryId: string }>;
  queries: ReadonlyArray<{ id: string; spec?: { timeRanges?: unknown } }>;
}): { groups: DashboardTimeRangeGroup[]; diagnostics: TimeRangeGroupDiagnostic[] } {
  const queryById = new Map(input.queries.map((query) => [query.id, query] as const));
  const groupsByKey = new Map<string, DashboardTimeRangeGroup>();
  const diagnostics: TimeRangeGroupDiagnostic[] = [];

  const addGroup = (candidate: DashboardTimeRangeGroup, tileId: string): void => {
    const existing = groupsByKey.get(candidate.key);
    if (existing) existing.tileIds.push(tileId);
    else groupsByKey.set(candidate.key, { ...candidate, tileIds: [tileId] });
  };

  for (const tile of input.tiles) {
    const query = queryById.get(tile.queryId);
    const ranges = query?.spec?.timeRanges;
    const hasAuthoredRanges = query?.spec != null
      && Object.prototype.hasOwnProperty.call(query.spec, 'timeRanges');
    if (!hasAuthoredRanges) {
      // Compatibility for saved queries authored before #334 metadata: infer
      // only among filters that actually target this tile, then reuse the
      // exact same contract gate as authored metadata. Inference is silent and
      // fail-closed, matching #335; saving/committing the query will persist an
      // explicit pair or [] and make the choice authoritative thereafter.
      const tileFilters = input.filters.filter((filter) => input.filterTargetTileIds.get(filter.id)?.has(tile.id));
      const inferred = resolveTimeRangeGroups({
        filters: input.filters,
        analysis: input.analysis,
        executableTileIds: input.executableTileIds,
        pairs: inferTimeRangePairs(tileFilters),
      });
      for (const candidate of inferred) addGroup(candidate, tile.id);
      continue;
    }
    if (Array.isArray(ranges) && ranges.length === 0) continue;
    const malformed = (): void => {
      diagnostics.push({
        tileId: tile.id, queryId: tile.queryId, code: 'time-range-contract-invalid',
        message: `Time range metadata for ${tile.queryId} is invalid and cannot participate in a Dashboard group.`,
      });
    };
    if (!Array.isArray(ranges) || ranges.length !== 1) { malformed(); continue; }
    const raw = ranges[0];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { malformed(); continue; }
    const pair = raw as Record<string, unknown>;
    if (typeof pair.from !== 'string' || typeof pair.to !== 'string' || pair.from === pair.to) { malformed(); continue; }
    const matching = (parameter: string) => input.filters.filter((filter) => filter.parameter === parameter
      && input.filterTargetTileIds.get(filter.id)?.has(tile.id));
    const from = matching(pair.from);
    const to = matching(pair.to);
    if (from.length !== 1 || to.length !== 1 || from[0].id === to[0].id) {
      diagnostics.push({
        tileId: tile.id, queryId: tile.queryId, code: 'time-range-filter-unresolved',
        message: `Time range for ${tile.queryId} could not resolve both parameters to one targeted Dashboard filter each.`,
      });
      continue;
    }
    const resolved = resolveTimeRangeGroups({
      filters: input.filters, analysis: input.analysis, executableTileIds: input.executableTileIds,
      pairs: [{ fromFilterId: from[0].id, toFilterId: to[0].id }],
    });
    if (resolved.length !== 1) {
      diagnostics.push({
        tileId: tile.id, queryId: tile.queryId, code: 'time-range-contract-invalid',
        message: `Time range for ${tile.queryId} does not resolve to two compatible scalar date/time filter contracts.`,
      });
      continue;
    }
    addGroup(resolved[0], tile.id);
  }
  return { groups: [...groupsByKey.values()], diagnostics };
}

// ── Draft validation ─────────────────────────────────────────────────────

/** One bound's (From's or To's) staged-draft resolution. `display` and
 *  `instantMs` are both null exactly when `!ok`. `matchedRelative` is true
 *  only when the text actually parsed as a relative-time expression (as
 *  opposed to an absolute value or an empty/invalid entry) — mirrors
 *  `formatPreview`'s/`resolveRelativeValue`'s own `matched` flag. */
export interface TimeRangeBoundDraft {
  ok: boolean;
  display: string | null;
  instantMs: number | null;
  error: string | null;
  matchedRelative: boolean;
}

function resolveBound(text: string, type: ParsedParamType | string, nowMs: number): TimeRangeBoundDraft {
  const t = typeof type === 'string' ? parseParamType(type) : type;
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, display: null, instantMs: null, error: 'A value is required.', matchedRelative: false };
  }

  const parsed = parseRelativeExpr(trimmed);
  if (isRelativeParseError(parsed)) {
    return { ok: false, display: null, instantMs: null, error: parsed.error, matchedRelative: false };
  }
  if (parsed) {
    const instantMs = resolveInstant(parsed, nowMs);
    return { ok: true, display: formatPreviewInstant(instantMs, t), instantMs, error: null, matchedRelative: true };
  }

  const abs = parseAbsoluteInstant(t, trimmed);
  if (!abs.ok) {
    return { ok: false, display: null, instantMs: null, error: abs.error, matchedRelative: false };
  }
  return { ok: true, display: formatPreviewInstant(abs.instantMs, t), instantMs: abs.instantMs, error: null, matchedRelative: false };
}

/**
 * Validate a staged From/To draft against ONE shared wall-clock snapshot
 * (`nowMs`) — the issue's "single preview `now`" rule: both bounds resolve
 * their relative tokens (if any) against the same instant, so `now` in From
 * and `now` in To always agree within one validation pass. Resolution per
 * bound: `parseRelativeExpr` first (a genuine parse resolves via
 * `resolveInstant(nowMs)`; a near-miss is `!ok` with that grammar error;
 * `null` — not relative at all — falls through to `parseAbsoluteInstant`);
 * empty/whitespace-only text is `!ok` with a "required" diagnostic before
 * either parser runs. `rangeOk` requires both bounds to resolve AND
 * `fromInstant <= toInstant` (equal instants are explicitly permitted);
 * `rangeError` is set only when both bounds resolve but `from > to` — a
 * per-bound `error` already covers an unresolvable bound, so this is never
 * set redundantly alongside one. Pure.
 */
export function validateTimeRangeDraft(input: {
  fromText: string;
  toText: string;
  fromType: ParsedParamType | string;
  toType: ParsedParamType | string;
  nowMs: number;
}): {
  from: TimeRangeBoundDraft;
  to: TimeRangeBoundDraft;
  rangeOk: boolean;
  rangeError: string | null;
  applyEnabled: boolean;
} {
  const from = resolveBound(input.fromText, input.fromType, input.nowMs);
  const to = resolveBound(input.toText, input.toType, input.nowMs);

  let rangeOk = from.ok && to.ok;
  let rangeError: string | null = null;
  if (rangeOk && from.instantMs! > to.instantMs!) {
    rangeOk = false;
    rangeError = 'The "from" bound must not be after the "to" bound.';
  }

  return { from, to, rangeOk, rangeError, applyEnabled: from.ok && to.ok && rangeOk };
}

/** Convert Chart.js's local-wall-clock epoch convention back to the UTC
 * server-wall-clock convention used by the existing date/time parameter
 * pipeline, then format each bound for its own declared type. Date/Date32
 * retain the selected calendar digits directly (no hidden day adjustment). */
export function formatChartTimeRange(input: {
  fromMs: number;
  toMs: number;
  fromType: ParsedParamType | string;
  toType: ParsedParamType | string;
}): { ok: true; from: string; to: string; fromLabel: string; toLabel: string } | { ok: false; error: string } {
  if (!Number.isFinite(input.fromMs) || !Number.isFinite(input.toMs)) {
    return { ok: false, error: 'The selected time range is invalid.' };
  }
  const lo = Math.min(input.fromMs, input.toMs);
  const hi = Math.max(input.fromMs, input.toMs);
  const format = (ms: number, type: ParsedParamType | string): string => {
    const parsed = typeof type === 'string' ? parseParamType(type) : type;
    if (parsed.base === 'Date' || parsed.base === 'Date32') {
      const scaleValue = instantToChartScaleTime(ms, parsed);
      return formatTimeParamValue(scaleValue ?? ms, parsed);
    }
    return formatTimeParamValue(ms, parsed);
  };
  const from = format(lo, input.fromType);
  const to = format(hi, input.toType);
  const fromType = typeof input.fromType === 'string' ? parseParamType(input.fromType) : input.fromType;
  const toType = typeof input.toType === 'string' ? parseParamType(input.toType) : input.toType;
  return {
    ok: true, from, to,
    fromLabel: formatPreviewInstant(lo, fromType),
    toLabel: formatPreviewInstant(hi, toType),
  };
}

function zonedParts(epochMs: number, timeZone: string): number[] | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA-u-hc-h23', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(epochMs));
    const value = (name: string): number => Number(parts.find((part) => part.type === name)?.value);
    const out = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(value);
    return out.every(Number.isFinite) ? out : null;
  } catch {
    return null;
  }
}

/** Convert Chart.js's local-wall-clock scale convention into one canonical
 * epoch instant, honoring an explicit ClickHouse timezone when present. */
export function chartScaleTimeToInstant(ms: number, type: ParsedParamType | string): number | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const desired = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  const desiredUtc = Date.UTC(desired[0], desired[1] - 1, desired[2], desired[3], desired[4], desired[5], d.getMilliseconds());
  const zone = dateTimeTimeZone(type) || 'UTC';
  let candidate = desiredUtc;
  for (let i = 0; i < 2; i++) {
    const shown = zonedParts(candidate, zone);
    if (!shown) return null;
    const shownUtc = Date.UTC(shown[0], shown[1] - 1, shown[2], shown[3], shown[4], shown[5], d.getMilliseconds());
    candidate += desiredUtc - shownUtc;
  }
  return candidate;
}

/** Convert a canonical instant to the pseudo-local epoch expected by the
 * existing Chart.js wall-clock parser for a declared ClickHouse timezone. */
export function instantToChartScaleTime(ms: number, type: ParsedParamType | string): number | null {
  if (!Number.isFinite(ms)) return null;
  const shown = zonedParts(ms, dateTimeTimeZone(type) || 'UTC');
  if (!shown) return null;
  return new Date(shown[0], shown[1] - 1, shown[2], shown[3], shown[4], shown[5], new Date(ms).getUTCMilliseconds()).getTime();
}

/** Human label for one Chart.js time-scale value, preserving the server's
 * wall-clock digits across browser timezones. */
export function formatChartTimeLabel(ms: number, type: ParsedParamType | string): string {
  const parsed = typeof type === 'string' ? parseParamType(type) : type;
  return formatPreviewInstant(ms, parsed);
}

// ── Recently used ────────────────────────────────────────────────────────

/** One recorded From/To token pair — the RAW committed text of each bound,
 *  never the resolved instant (a relative pair like `-1d` → `now` must
 *  re-display and re-apply as that live token, not a frozen absolute). */
export interface TimeRangeRecent {
  from: string;
  to: string;
}

/**
 * Push a newly-committed range onto a "Recently used" list: dedupe by EXACT
 * token-pair equality (both `from` AND `to` match a stored entry), unshift
 * newest-first, cap at 6. Immutable — always returns a NEW array, never
 * mutates `list`. Pure.
 */
export function pushRecentRange(
  list: ReadonlyArray<TimeRangeRecent>,
  pair: TimeRangeRecent,
): TimeRangeRecent[] {
  const deduped = list.filter((r) => !(r.from === pair.from && r.to === pair.to));
  return [pair, ...deduped].slice(0, 6);
}
