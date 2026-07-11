// Pure MRU (most-recently-used) history of the values a user has actually run
// for each `{name:Type}` variable (#171) — recorded from a successful
// statement's `boundParams` (#173's immutable per-statement snapshots), never
// from a keystroke. Storage wiring (the `asb:varRecent` key, load/persist)
// stays in state.js/app.js, exactly like `varValues` — this module only
// operates on the in-memory map shape.
//
// Shape (versioned + sequence-stamped, not a flat `{[name]: string[]}` — a
// flat shape carries no ordering *between* names, which the global-LRU total
// cap needs):
//   { version: 1, nextSeq: N, byName: { name: [{value, seq}, ...] } }
// Each name's array is newest-first (index 0 = most recent); `seq` is a
// strictly-increasing global counter, so sorting every name's entries
// together by `seq` gives one true global recency order for the total-cap
// eviction below.
//
// Name-keyed globally (not per type/connection) — deliberately mirrors
// `state.varValues`, which is itself name-global (see state.js).

import { validateParamValue } from './param-validate.js';

/** Per-variable cap (acceptance criteria: "after 11 distinct values, the
 *  oldest is gone" — 10 survive). */
export const VAR_RECENT_PER_NAME_CAP = 10;

/** Global cap across every name's history combined, so a session that types
 *  many one-off variable names can't grow `asb:varRecent` unboundedly. */
export const VAR_RECENT_TOTAL_CAP = 100;

/** A fresh, empty recent-values map. */
export function emptyRecentMap() {
  return { version: 1, nextSeq: 1, byName: {} };
}

function asMap(map) {
  return map && map.byName ? map : emptyRecentMap();
}

/** Evict the globally-lowest-`seq` entries (across every name) until the
 *  total entry count is at or under `VAR_RECENT_TOTAL_CAP`. A no-op (returns
 *  `map` unchanged, same reference) when already within the cap — every
 *  `recordRecent` call grows the total by at most one entry, so this is
 *  almost always a single eviction in practice, but the general form handles
 *  a map that arrived over-cap from anywhere (e.g. a lowered cap). Pure. */
function enforceTotalCap(map) {
  let total = 0;
  for (const name in map.byName) total += map.byName[name].length;
  if (total <= VAR_RECENT_TOTAL_CAP) return map;
  const flat = [];
  for (const name in map.byName) {
    for (const e of map.byName[name]) flat.push({ name, seq: e.seq });
  }
  flat.sort((a, b) => a.seq - b.seq);
  const toRemove = flat.slice(0, total - VAR_RECENT_TOTAL_CAP);
  const removeSeqs = new Map(); // name -> Set(seq)
  for (const e of toRemove) {
    if (!removeSeqs.has(e.name)) removeSeqs.set(e.name, new Set());
    removeSeqs.get(e.name).add(e.seq);
  }
  const byName = {};
  for (const name in map.byName) {
    const drop = removeSeqs.get(name);
    const list = drop ? map.byName[name].filter((e) => !drop.has(e.seq)) : map.byName[name];
    if (list.length) byName[name] = list;
  }
  return { version: map.version, nextSeq: map.nextSeq, byName };
}

/**
 * Record a successful run's `value` for variable `name`: move-to-front if
 * already present (exact-string dedupe, no duplicate entry), else insert at
 * the front; capped at `VAR_RECENT_PER_NAME_CAP` per name and
 * `VAR_RECENT_TOTAL_CAP` globally (lowest-`seq` eviction). An empty string (or
 * null/undefined) is never recorded — deliberately, even though #165 allows an
 * active empty value to bind — and returns `map` unchanged (same reference,
 * so callers can cheaply detect a no-op). Pure — returns a new map, never
 * mutates `map`.
 * @param {ReturnType<typeof emptyRecentMap>|undefined} map
 * @param {string} name
 * @param {string} value
 */
export function recordRecent(map, name, value) {
  if (value == null || value === '') return map || emptyRecentMap();
  const m = asMap(map);
  const seq = m.nextSeq;
  const existing = m.byName[name] || [];
  const deduped = existing.filter((e) => e.value !== value);
  const list = [{ value, seq }, ...deduped].slice(0, VAR_RECENT_PER_NAME_CAP);
  const byName = { ...m.byName, [name]: list };
  return enforceTotalCap({ version: 1, nextSeq: seq + 1, byName });
}

/** Clear one variable's recent-value history. Returns `map` unchanged (same
 *  reference) when `name` has no history — a cheap no-op signal for callers
 *  deciding whether to re-persist. Pure. */
export function clearRecent(map, name) {
  const m = asMap(map);
  if (!(name in m.byName)) return m;
  const byName = { ...m.byName };
  delete byName[name];
  return { version: m.version, nextSeq: m.nextSeq, byName };
}

/** Clear every variable's recent-value history (a fresh empty map). */
export function clearAllRecent() {
  return emptyRecentMap();
}

/**
 * The render-time type-filtering helper: `name`'s recorded values (newest
 * first), with any value #170's validator marks `'invalid'` against the
 * field's *current* declared `type` hidden — not deleted, so a `{id:UInt64}`
 * recent hidden while the same-named param is briefly declared `{id:String}`
 * elsewhere reappears once it's viewed through a compatible declaration
 * again. `'valid'`/`'incomplete'`/`'unknown'` all pass the filter (permissive,
 * matching param-validate.js's own philosophy — never hide a value the
 * validator merely doesn't have an opinion on). Pure.
 * @param {ReturnType<typeof emptyRecentMap>|undefined} map
 * @param {string} name
 * @param {string} type declared `{name:Type}` type text
 * @returns {string[]}
 */
export function visibleRecents(map, name, type) {
  const list = (map && map.byName && map.byName[name]) || [];
  return list
    .filter((e) => validateParamValue(type, e.value).status !== 'invalid')
    .map((e) => e.value);
}

/** Case-insensitive substring filter over a recent-value list (type-to-filter,
 *  #174 §1) — a blank query returns `list` unchanged (same reference, mirroring
 *  `filterPresets` in relative-time-field.js). Pure. */
export function filterRecentValues(list, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((v) => String(v).toLowerCase().includes(q));
}

/** `name`'s recents, live-filtered by both the field's current declared
 *  `type` (visibleRecents) and the currently-typed `text` (filterRecentValues)
 *  — the single call the recents-dropdown UI (recent-field.js /
 *  relative-time-field.js) makes on every open/keystroke, so a value recorded
 *  after the field was built is never stale. Pure. */
export function recentOptions(map, name, type, text) {
  return filterRecentValues(visibleRecents(map, name, type), text);
}
