// RFC 7396 JSON Merge Patch (#280 "Presentation variants and tile overrides").
// Net-new, in-house, pure — no dependency (hard rule 4). The exact RFC 7396
// semantics that presentation variants and tile overrides rely on:
//   - a non-object patch (array, primitive, or null) REPLACES the target
//     wholesale — arrays are never index-merged or concatenated;
//   - an object patch merges recursively into an object target (a non-object
//     target is treated as an empty object first);
//   - a `null` member DELETES that property from the result;
//   - every other member is applied recursively.
// The result never shares structure with either input: `cloneJson` deep-copies
// every retained/replacement value so a resolved panel can be mutated freely.

import { cloneJson } from '../../core/saved-query.js';

/** A merge-patch "object" is a non-null, non-array object; arrays and
 *  primitives are opaque replacement values under RFC 7396. */
export function isMergePatchObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Apply one RFC 7396 JSON Merge Patch. Returns a fresh value; neither `target`
 *  nor `patch` is mutated, and the result shares no structure with either. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isMergePatchObject(patch)) return cloneJson(patch);
  const base = isMergePatchObject(target) ? target : {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(base)) result[key] = cloneJson(base[key]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyMergePatch(result[key], value);
  }
  return result;
}
