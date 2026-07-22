// Dashboard time-range control (#335) — a pure resolver that (a) discovers
// candidate From/To filter-id pairs by #334's interim name-pair table, (b)
// gates a candidate pair into a `DashboardTimeRangeGroup` only when BOTH
// filters resolve to a scalar, date-like consumer contract (reusing
// `filter-selection.ts`'s #189 consumer-resolution machinery rather than
// re-deriving it), (c) validates a staged From/To draft against the shared
// relative/absolute grammar (`relative-time.ts`), and (d) maintains the
// session-scoped "Recently used" list. No DOM, no globals, no fetch — `nowMs`
// is always injected (the repo's keystroke rule).
//
// Pair discovery is a SEAM (`resolveTimeRangeGroups`'s optional `pairs`
// argument), not a hard dependency on `inferTimeRangePairs`: #334's saved-
// query `timeRanges` metadata is meant to replace the inference source
// without touching this module's gating logic or any UI built on top of it.
//
// Group formation never mutates anything — it's a pure re-derivation over the
// dashboard's current filter defs, analysis, and executable-tile set, exactly
// like `resolveFilterSelection` itself.

import { resolveFilterSelection } from './filter-selection.js';
import type { FilterSelectionFilterDef } from './filter-selection.js';
import type { ParameterAnalysis } from './param-pipeline.js';
import type { ParsedParamType } from './param-type.js';
import { parseParamType } from './param-type.js';
import {
  parseRelativeExpr,
  resolveInstant,
  formatPreviewInstant,
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
 * `isDateLikeType(contract.type)` — a filter missing from `input.filters`
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
    if (fromRes.diagnostics.length || toRes.diagnostics.length) continue;
    if (!fromRes.contract || !toRes.contract) continue;
    if (fromRes.contract.array || toRes.contract.array) continue;
    if (!isDateLikeType(fromRes.contract.type) || !isDateLikeType(toRes.contract.type)) continue;

    groups.push({
      key: `${fromFilter.id}\u0000${toFilter.id}`,
      fromFilterId: fromFilter.id,
      toFilterId: toFilter.id,
      fromParameter: fromFilter.parameter,
      toParameter: toFilter.parameter,
      fromType: fromRes.contract.type,
      toType: toRes.contract.type,
    });
  }
  return groups;
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
