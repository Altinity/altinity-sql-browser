// Dashboard time-range control (#335) — pure validation and grouping support
// for the authoritative saved-query metadata introduced by #334. It (a) gates a
// candidate pair into a `DashboardTimeRangeGroup` only when both VARIABLES are
// declared with one agreed date-like type by at least one executable tile, (c)
// validates a staged From/To draft against the shared relative/absolute grammar
// (`relative-time.ts`), and (d) maintains the session-scoped "Recently used"
// list. No DOM, no globals, no fetch — `nowMs` is always injected (the repo's
// keystroke rule).
//
// Pair discovery remains a seam (`resolveTimeRangeGroups`'s optional `pairs`
// argument); runtime callers derive those pairs from saved-query `timeRanges`
// metadata without coupling that persistence concern to the validation logic.
//
// #447 re-based this module from curated filter definitions onto inferred
// variables. It used to reuse `filter-selection.ts`'s #189 consumer-resolution
// machinery to agree each bound's contract across a filter's explicit targets,
// including whether that contract was an ARRAY. A variable has no targets and no
// array form — it is one exact name bound to whichever panel queries declare it,
// always scalar — so the declared type IS the contract and that module is gone.
//
// Group formation never mutates anything — it's a pure re-derivation over the
// Dashboard's current variables, analysis, and executable-tile set.

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
 * The identity a time-range candidate needs from one inferred Dashboard variable
 * (#447). A variable's exact name is its ONLY identity — it is simultaneously
 * what used to be a filter's `id` and its `parameter`.
 */
export interface TimeRangeVariable {
  /** The exact, case-sensitive variable name. */
  name: string;
  /** The type every panel declaration agrees on, or `null` when they conflict —
   *  a conflicted variable can never join a group. */
  type: string | null;
  /** Dashboard-local option SQL, or `null` for a direct-input variable. Only a
   *  direct-input variable is a range candidate: a From/To bound is typed by
   *  hand or picked from a calendar, never chosen from a query's option list. */
  sql: string | null;
}

/**
 * One resolved time-range group: a pair of Dashboard variables whose declared
 * types are both date-like. `key` is derived purely from the two variables' own
 * names (never labels, never array index) so it's stable across a group list
 * re-render as long as the underlying names don't change.
 *
 * `fromVariableId`/`toVariableId` hold VARIABLE NAMES. The field names are #335's
 * and are deliberately unchanged: renaming them would churn the Dashboard view,
 * the chart interaction controller, the range control and two e2e fixtures for
 * no semantic gain. A rename belongs with the wider terminology cleanup.
 */
export interface DashboardTimeRangeGroup {
  key: string;
  fromVariableId: string;
  toVariableId: string;
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
  code: 'time-range-variable-unresolved' | 'time-range-contract-invalid';
  message: string;
}

/** One candidate pair of VARIABLE NAMES — `inferTimeRangePairs`'s output, and the
 *  shape #334's saved-query-metadata resolution produces in its place (same seam,
 *  see this module's header comment). The field names are #335's, kept for the
 *  reason `DashboardTimeRangeGroup` documents. */
export interface TimeRangePairCandidate {
  fromVariableId: string;
  toVariableId: string;
}

// #334's interim recognized name-pair table (case-insensitive exact match on
// the FULL parameter name — never a prefix/substring match). Order here is
// also the emission order when more than one row matches distinct variables.
// `start`/`stop` is deliberately NOT a recognized pair (owner decision).
const NAME_PAIR_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['from', 'to'],
  ['from_time', 'to_time'],
  ['start', 'end'],
  ['start_time', 'end_time'],
];

/**
 * Interim pair-discovery source (#334's table): infer From/To candidate pairs
 * from the Dashboard's variable names alone, with no notion of declared types
 * yet (that's `resolveTimeRangeGroups`'s job). Rules:
 *  - a variable carrying option SQL is NEVER a candidate — filtered out before
 *    any name matching;
 *  - matching is case-insensitive but exact (the whole name, not a substring)
 *    against `NAME_PAIR_TABLE`;
 *  - a table entry matched by MORE THAN ONE variable is unusable — any pair that
 *    would need it does not form, for either role. Variable names are exact and
 *    case-SENSITIVE while this table matches case-INSENSITIVELY, so `From` and
 *    `from` are two distinct variables that both match the same entry: neither
 *    can be chosen over the other, and the entry is dropped;
 *  - a variable may appear in at most one emitted pair; if the name-pair table
 *    would place one variable in two candidate pairs, EVERY pair involving it is
 *    dropped (ambiguity → no group, not a guess at which pair "wins").
 * Pure.
 */
export function inferTimeRangePairs(
  variables: ReadonlyArray<TimeRangeVariable>,
): TimeRangePairCandidate[] {
  const eligible = variables.filter((variable) => variable.sql == null);

  // Group eligible variables by lowercased name so an entry matched by more than
  // one variable can be recognized as unusable.
  const byName = new Map<string, string[]>();
  for (const variable of eligible) {
    const key = variable.name.toLowerCase();
    const ids = byName.get(key) || [];
    ids.push(variable.name);
    byName.set(key, ids);
  }
  const soleIdFor = (name: string): string | null => {
    const ids = byName.get(name);
    return ids && ids.length === 1 ? ids[0] : null;
  };

  // #447 removed a second, cross-entry ambiguity guard here. It dropped any
  // candidate whose participant appeared in more than one raw pair — reachable
  // when a bound was a curated filter, because a filter's `id` and `parameter`
  // were independent, so two defs could share an id while matching different
  // table entries. A variable's identity IS its name, every name lowercases to
  // exactly one key, and all eight keys in `NAME_PAIR_TABLE` are distinct, so one
  // variable can now serve at most one role in at most one entry. The guard's
  // precondition is structurally unreachable, and keeping it would be an
  // untestable branch rather than a safety net.
  const pairs: TimeRangePairCandidate[] = [];
  for (const [fromName, toName] of NAME_PAIR_TABLE) {
    const fromVariableId = soleIdFor(fromName);
    const toVariableId = soleIdFor(toName);
    if (fromVariableId && toVariableId) pairs.push({ fromVariableId, toVariableId });
  }
  return pairs;
}

/**
 * Gate candidate pairs into resolved `DashboardTimeRangeGroup`s. `pairs` defaults
 * to `inferTimeRangePairs(input.variables)` — the seam #334's metadata resolution
 * supplies instead, without this gating logic changing.
 *
 * A pair forms a group ONLY when both variables are declared with ONE agreed
 * date-like type and at least one EXECUTABLE tile declares each of them. A
 * variable missing from `input.variables` (only possible when a caller supplies
 * its own `pairs`) is skipped rather than throwing. Emitted in `pairs`' own
 * order. Pure — never mutates its input.
 *
 * #447 replaced a `resolveFilterSelection` call here. That resolver existed to
 * agree a curated helper's contract across a filter's explicit targets, including
 * whether the agreed type was an ARRAY — a distinction a variable cannot have,
 * because a variable is one name bound to whichever panels declare it and its
 * value is always a scalar. So the array gate is gone and the type comes straight
 * from the declarations.
 */
export function resolveTimeRangeGroups(input: {
  variables: ReadonlyArray<TimeRangeVariable>;
  analysis: ParameterAnalysis;
  executableTileIds: ReadonlySet<string>;
  pairs?: TimeRangePairCandidate[];
}): DashboardTimeRangeGroup[] {
  const { variables, analysis, executableTileIds } = input;
  const byName = new Map(variables.map((variable) => [variable.name, variable] as const));
  const pairs = input.pairs ?? inferTimeRangePairs(variables);

  /** The declared date-like type of a variable that at least one EXECUTABLE tile
   *  declares, or `null` when it cannot join a group. */
  const bound = (name: string): ParsedParamType | null => {
    const variable = byName.get(name);
    if (!variable || variable.type === null) return null;
    if (!isSupportedTimeRangeParamType(variable.type)) return null;
    const field = analysis.fields[name];
    if (!field) return null;
    const declaredBy = field.requiredIn.concat(field.optionalIn);
    if (!declaredBy.some((tileId) => executableTileIds.has(tileId))) return null;
    return parseParamType(variable.type);
  };

  const groups: DashboardTimeRangeGroup[] = [];
  for (const pair of pairs) {
    const fromType = bound(pair.fromVariableId);
    const toType = bound(pair.toVariableId);
    if (!fromType || !toType) continue;

    groups.push({
      key: `${pair.fromVariableId}\u0000${pair.toVariableId}`,
      fromVariableId: pair.fromVariableId,
      toVariableId: pair.toVariableId,
      fromParameter: pair.fromVariableId,
      toParameter: pair.toVariableId,
      fromType,
      toType,
      tileIds: [],
      interactiveChartTileIds: [],
    });
  }
  return groups;
}

/** Resolve saved-query time-range metadata to Dashboard variable identities,
 * then aggregate every participating tile by that ordered identity pair.
 * Queries created before `timeRanges` existed retain #335's conservative
 * load-time name inference; an authored empty array is the explicit opt-out,
 * while a non-empty authored value remains authoritative. Variable targeting is
 * supplied by the viewer session's single authoritative resolver; this core
 * function never reimplements target semantics. */
export function resolveAuthoredTimeRangeGroups(input: {
  variables: ReadonlyArray<TimeRangeVariable>;
  analysis: ParameterAnalysis;
  executableTileIds: ReadonlySet<string>;
  /** Variable NAME -> the tile ids that variable binds to, from the viewer
   *  session's single authoritative resolver. */
  variableTargetTileIds: ReadonlyMap<string, ReadonlySet<string>>;
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
      // only among variables that actually target this tile, then reuse the
      // exact same contract gate as authored metadata. Inference is silent and
      // fail-closed, matching #335; saving/committing the query will persist an
      // explicit pair or [] and make the choice authoritative thereafter.
      const tileVariables = input.variables.filter(
        (variable) => input.variableTargetTileIds.get(variable.name)?.has(tile.id),
      );
      const inferredPairs = inferTimeRangePairs(tileVariables);
      // A legacy query with two distinct recognized pairs is just as
      // ambiguous as it is during authoring. Never attach one tile to several
      // groups and let the chart layer guess which pair its X scale means.
      if (inferredPairs.length !== 1) continue;
      const inferred = resolveTimeRangeGroups({
        variables: input.variables,
        analysis: input.analysis,
        executableTileIds: input.executableTileIds,
        pairs: inferredPairs,
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
    // Authored metadata names PARAMETERS; a variable's name IS its parameter, so
    // this resolves the name to the variable of that exact name, and only when
    // that variable actually binds to this tile.
    // A name resolves to at most ONE variable (names are unique), and the two
    // names are already known to differ — a `from === to` pair was rejected as
    // malformed above — so "resolved" is simply "both names found".
    const matching = (parameter: string) => input.variables.find((variable) => variable.name === parameter
      && input.variableTargetTileIds.get(variable.name)?.has(tile.id));
    const from = matching(pair.from);
    const to = matching(pair.to);
    if (from === undefined || to === undefined) {
      diagnostics.push({
        tileId: tile.id, queryId: tile.queryId, code: 'time-range-variable-unresolved',
        message: `Time range for ${tile.queryId} could not resolve both parameters to one Dashboard variable each.`,
      });
      continue;
    }
    const resolved = resolveTimeRangeGroups({
      variables: input.variables, analysis: input.analysis, executableTileIds: input.executableTileIds,
      pairs: [{ fromVariableId: from.name, toVariableId: to.name }],
    });
    if (resolved.length !== 1) {
      diagnostics.push({
        tileId: tile.id, queryId: tile.queryId, code: 'time-range-contract-invalid',
        message: `Time range for ${tile.queryId} does not resolve to two compatible date/time variable types.`,
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

/** Human-readable editor/list text for an absolute epoch token. Relative
 * expressions and already-readable absolute values stay verbatim; only the
 * numeric wire forms produced for DateTime/DateTime64 are projected to their
 * calendar preview. The caller retains the original token for commits. */
export function formatTimeRangeDisplayValue(
  text: string,
  type: ParsedParamType | string,
): string {
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return text;
  const parsed = parseAbsoluteInstant(type, trimmed);
  if (!parsed.ok) return text;
  const t = typeof type === 'string' ? parseParamType(type) : type;
  return formatPreviewInstant(parsed.instantMs, t);
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

/** Chart.js time scales already exchange real epoch instants. Validate an
 * explicit ClickHouse timezone (so an invalid declaration still fails closed),
 * but do not reinterpret the epoch through the browser's local timezone. */
export function chartScaleTimeToInstant(ms: number, type: ParsedParamType | string): number | null {
  if (!Number.isFinite(ms)) return null;
  const zone = dateTimeTimeZone(type) || 'UTC';
  return zonedParts(ms, zone) ? ms : null;
}

/** Chart.js time scales accept canonical epoch instants directly. */
export function instantToChartScaleTime(ms: number, type: ParsedParamType | string): number | null {
  if (!Number.isFinite(ms)) return null;
  return zonedParts(ms, dateTimeTimeZone(type) || 'UTC') ? ms : null;
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
