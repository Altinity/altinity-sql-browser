// Fail-closed decoders for the persisted-domain reads `state.ts`'s
// `createState` performs at the localStorage load boundary (#591) — the
// remaining `as`-cast sites left after #587 (sidePanel) and #586
// (rightInspectorPx). Pure: each decoder is a total function over `unknown`
// built entirely from type guards, so it is structurally incapable of
// throwing — mirrors the `decodeStoredSavedQueries` precedent in
// `core/library-codec.ts`, just for shapes small enough to share one module.

import { isPlainObject } from './saved-query.js';
import { emptyRecentMap } from './recent-values.js';
import type { RecentMap, RecentValueEntry } from './recent-values.js';

/** One executed-query history entry (most-recent first, capped at
 *  `HISTORY_MAX_ENTRIES`). Moved here from `state.ts` (#591) — `state.ts`
 *  re-exports the type so every existing importer keeps compiling unchanged
 *  (the `ResultSort` → `core/sort.ts` precedent). */
export interface HistoryEntry {
  id: string;
  sql: string;
  ts: number;
  /** Row count of the recorded run; null for raw-FORMAT results and scripts. */
  rows: number | null;
  ms: number;
}

/** The write-side cap `pushHistory` (state.ts) enforces and the decode-side
 *  cap below enforces too, from the same constant so they cannot drift. */
export const HISTORY_MAX_ENTRIES = 50;

/** Decode the persisted `asb:varValues` map (#134): any non-plain-object
 *  top-level value fails closed to `{}`; a well-formed top level keeps only
 *  the entries whose value is a string, dropping the rest. Always returns a
 *  freshly built record (never the input by reference) — `app.ts` mutates
 *  this object in place. */
export function decodeStoredVarValues(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

/** Decode the persisted `asb:filterActive` map (#165) — same shape and
 *  entry-drop rule as `decodeStoredVarValues`, but for booleans. */
export function decodeStoredFilterActive(value: unknown): Record<string, boolean> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>;
}

function isValidRecentEntry(e: unknown): e is RecentValueEntry {
  return isPlainObject(e) && typeof e.value === 'string' && Number.isFinite(e.seq);
}

/** Decode the persisted `asb:varRecent` map (#171): the top level must be a
 *  plain object with `version === 1`, an integer `nextSeq >= 1`, and a plain-
 *  object `byName`, or the whole value fails closed to a *fresh*
 *  `emptyRecentMap()`. Once the top level validates, each name's list is
 *  kept only if it is an array; within it, only entries shaped like a real
 *  `RecentValueEntry` survive; a name whose filtered list ends up empty is
 *  dropped entirely (mirrors `enforceTotalCap`, which never emits empty
 *  lists). */
export function decodeStoredRecentMap(value: unknown): RecentMap {
  if (
    !isPlainObject(value) || value.version !== 1
    || !Number.isInteger(value.nextSeq) || (value.nextSeq as number) < 1
    || !isPlainObject(value.byName)
  ) return emptyRecentMap();
  const byName: Record<string, RecentValueEntry[]> = {};
  for (const [name, list] of Object.entries(value.byName)) {
    if (!Array.isArray(list)) continue;
    const filtered = list.filter(isValidRecentEntry).map((e) => ({ value: e.value, seq: e.seq }));
    if (filtered.length) byName[name] = filtered;
  }
  return { version: 1, nextSeq: value.nextSeq as number, byName };
}

/** Decode the persisted `asb:varRecentDisabled` flag (#171) — strict:
 *  anything other than the literal boolean `true` fails closed to `false`,
 *  the documented default (a stored `"true"`/`1`/`{}` do not coerce). */
export function decodeStoredVarRecentDisabled(value: unknown): boolean {
  return value === true;
}

function isValidHistoryEntry(e: unknown): e is HistoryEntry {
  return isPlainObject(e) && typeof e.id === 'string' && typeof e.sql === 'string'
    && Number.isFinite(e.ts) && Number.isFinite(e.ms)
    && (e.rows === null || Number.isFinite(e.rows));
}

/** Decode the persisted `asb:history` list: a non-array top level fails
 *  closed to `[]`; otherwise each entry is kept (and projected to exactly
 *  `{id, sql, ts, rows, ms}`, dropping extra fields) only if it is shaped
 *  like a real `HistoryEntry`, then the result is capped at
 *  `HISTORY_MAX_ENTRIES` — the same bound `pushHistory` enforces on write. */
export function decodeStoredHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isValidHistoryEntry)
    .map((e) => ({ id: e.id, sql: e.sql, ts: e.ts, rows: e.rows, ms: e.ms }))
    .slice(0, HISTORY_MAX_ENTRIES);
}
