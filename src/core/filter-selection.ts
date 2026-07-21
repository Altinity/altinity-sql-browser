// #189: searchable multiselect Dashboard filters. A Filter helper (curated
// options UI) is only ever offered when every EXECUTABLE consumer of a
// filter's `{parameter:Type}` agrees on one compatible declared type — the
// same "agree or degrade" posture #173/#360 already use for cross-source type
// conflicts (`conflictingTypes`, `param-pipeline.ts`), applied here to decide
// the curated helper's selection mode instead of a bound value's validity.
//
// This module is pure: no DOM, no globals, no fetch. `resolveFilterSelection`
// takes a structural snapshot of a filter definition, the dashboard's
// `ParameterAnalysis` (#173), the caller's own notion of which tiles are
// currently executable, and any dependent Filter sources' own declarations of
// the same parameter (#360: a Filter source may declare `{name:Type}` params
// backed by another source's control) — and returns the agreed contract, the
// effective single/multiple mode, and every diagnostic that blocks the
// helper. `sameSelection`/`canonicalizeSelection`/`reconcileSelection` are the
// pure value-side helpers the multiselect control and its option-refresh
// reconciliation need once a helper IS exposed.

import { parseParamType, conflictingTypes } from './param-type.js';
import type { ParsedParamType } from './param-type.js';
import type { ParameterAnalysis } from './param-pipeline.js';
import { diagnostic } from './diagnostics.js';
import type { Diagnostic } from './diagnostics.js';

/**
 * Structural shape of a Dashboard filter definition `resolveFilterSelection`
 * needs — assignable FROM the generated `DashboardFilterDefinitionV1` (#189,
 * `src/generated/json-schema.types.ts`) without requiring that exact
 * interface, so tests (and any future caller) can pass a bare literal.
 * `selection.mode` is deliberately typed `string`, not the literal
 * `'single'|'multiple'` union — the JSON Schema normally blocks any other
 * value, but this module narrows defensively (the repo's convention for
 * every schema-adjacent enum-ish field, e.g. `bindPolicy` in
 * `param-pipeline.ts`) rather than trusting that upstream gate alone.
 */
export interface FilterSelectionFilterDef {
  id: string;
  parameter: string;
  targets?: string[];
  selection?: { mode?: string };
}

/**
 * One dependent Filter source's own declarations of the parameter being
 * resolved (#360: a Filter source may declare `{name:Type}` params backed by
 * ANOTHER source's control) — always an ADDITIONAL executable consumer,
 * regardless of the filter's `targets`, since a Filter source has no `targets`
 * concept of its own. `declarations` carries every occurrence's raw declared
 * type text, one entry per occurrence (mirrors `AnalyzedDeclaration.type` /
 * `conflictingTypes`'s own input shape — see `FilterSourceAnalysis` in
 * `filter-execution.ts`, whose `dependsOn` names the parameters a caller
 * would filter this down to) so a dependent source that declares the same
 * parameter twice with disagreeing types still surfaces as a conflict here.
 */
export interface FilterSelectionDependentSource {
  sourceId: string;
  label?: string;
  declarations: { type: string }[];
}

/**
 * The agreed consumer contract across every executable consumer of a filter's
 * parameter: whether they all declare it as a bare scalar (`array: false`) or
 * all as `Array(...)` (`array: true`), and the parsed VALUE type each
 * individual selection value must validate/serialize as — the scalar's own
 * type for a scalar contract, or the array's element type for an array one.
 * `resolveFilterSelection` only ever produces this when every consumer's
 * declaration is compatible (see its own doc comment for exactly what
 * "compatible" means).
 */
export interface FilterSelectionContract {
  array: boolean;
  type: ParsedParamType;
}

/**
 * `resolveFilterSelection`'s own diagnostic shape — this module's
 * `filter-selection-*` codes, always `severity: 'error'`: an unresolved
 * contract or mode always means the curated helper is unavailable (the plain
 * string-input fallback takes over), never a soft warning. Same convention as
 * `filter-execution.ts`'s `FilterSqlDiagnostic` over the shared
 * `diagnostics.ts` factory.
 */
export interface FilterSelectionDiagnostic extends Diagnostic {
  severity: 'error';
}

/**
 * `resolveFilterSelection`'s return shape. The curated Filter helper is
 * exposed IFF `diagnostics` is empty; `mode` is non-null exactly then too.
 * `contract` can still resolve (informationally — e.g. so a mode-table
 * diagnostic can name the agreed type) even when `diagnostics` is non-empty
 * for a reason unrelated to the type agreement itself (an explicit target
 * that fails closed, or `selection.mode: "multiple"` requested against a
 * scalar contract) — it is null only when the consumers themselves could not
 * agree on one type at all (no consumers, mixed arity, conflicting types, a
 * nested array).
 */
export interface FilterSelectionResolution {
  contract: FilterSelectionContract | null;
  mode: 'single' | 'multiple' | null;
  diagnostics: FilterSelectionDiagnostic[];
}

const err = (code: string, message: string, extra: Record<string, unknown> = {}): FilterSelectionDiagnostic =>
  diagnostic('error', code, message, extra) as FilterSelectionDiagnostic;

/**
 * Resolve one Dashboard filter's curated-helper contract and effective
 * selection mode (#189).
 *
 * Consumer gathering:
 *  - explicit `filter.targets`, when present and non-empty: each target id
 *    must be an `executableTileIds` member AND have at least one BOUND
 *    declaration of `filter.parameter` in `analysis` — a target missing
 *    either fails closed with its own diagnostic (and contributes no
 *    consumer entries), per target, so multiple bad targets each get their
 *    own diagnostic;
 *  - no `targets` (or an empty array): every executable tile with a bound
 *    declaration of the parameter;
 *  - `dependentSources`' own declarations of the parameter are ALWAYS
 *    additional consumers, on top of either of the above.
 *
 * Contract compatibility, over the gathered consumer declarations:
 *  - zero consumer declarations at all → `filter-selection-no-consumers`
 *    (suppressed when every explicit target already got its own diagnostic —
 *    that already explains the empty set without a redundant second one);
 *  - any declaration whose Array element is itself an Array
 *    (`parsed.elem?.isArray`) → `filter-selection-nested-array` (checked
 *    before arity/conflict below — nested arrays are unsupported outright,
 *    regardless of what else agrees or conflicts);
 *  - a mix of scalar and `Array(...)` declarations → `filter-selection-mixed-arity`;
 *  - all-scalar but incompatible per `conflictingTypes` (#238 `canonicalType`
 *    identity — wrapper-sensitive: `Nullable(T)`/`LowCardinality(T)` are
 *    DIFFERENT declarations from bare `T`, never silently unified) →
 *    `filter-selection-type-conflict`;
 *  - all-`Array` but conflicting ELEMENT types, by the same `conflictingTypes`
 *    identity applied to each element's own raw (wrapper-inclusive) type text
 *    → `filter-selection-array-element-conflict`.
 * This reuses `param-type.ts`'s existing compatibility primitive rather than
 * reinventing one — see its own doc comment for exactly what "conflicting"
 * means; this module makes no independent judgment call about it.
 *
 * Mode table (#189):
 *  | `selection.mode`      | contract  | effective    |
 *  |-----------------------|-----------|--------------|
 *  | omitted               | scalar    | `'single'`   |
 *  | omitted               | array     | `'multiple'` |
 *  | `'single'`            | scalar    | `'single'`   |
 *  | `'single'`            | array     | `'single'` (UI commits `[value]`) |
 *  | `'multiple'`          | array     | `'multiple'` |
 *  | `'multiple'`          | scalar    | INVALID — `filter-selection-mode-requires-array`, never silently downgraded |
 *  | any unrecognized non-empty string | (any) | INVALID — `filter-selection-unknown-mode` |
 *  | (any mode)            | no agreed contract | fallback (contract already null; no mode-table diagnostic added on top) |
 *
 * Pure.
 */
export function resolveFilterSelection(
  filter: FilterSelectionFilterDef,
  analysis: ParameterAnalysis,
  executableTileIds: ReadonlySet<string>,
  dependentSources: readonly FilterSelectionDependentSource[] = [],
): FilterSelectionResolution {
  const diagnostics: FilterSelectionDiagnostic[] = [];
  const name = filter.parameter;
  const field = analysis.fields[name];

  // ── Gather every executable consumer's raw declaration of {name} ─────────
  const entries: { sourceId: string; type: string }[] = [];
  let targetProblem = false;
  if (filter.targets && filter.targets.length) {
    for (const targetId of filter.targets) {
      if (!executableTileIds.has(targetId)) {
        targetProblem = true;
        diagnostics.push(err(
          'filter-selection-target-not-executable',
          `Filter "${filter.id}" target "${targetId}" is not an executable tile.`,
          { filterId: filter.id, parameter: name, sourceId: targetId },
        ));
        continue;
      }
      const bound = (field?.declarations || []).filter((d) => d.bound && d.source === targetId);
      if (!bound.length) {
        targetProblem = true;
        diagnostics.push(err(
          'filter-selection-target-missing-declaration',
          `Filter "${filter.id}" target "${targetId}" does not declare {${name}}.`,
          { filterId: filter.id, parameter: name, sourceId: targetId },
        ));
        continue;
      }
      for (const d of bound) entries.push({ sourceId: targetId, type: d.type });
    }
  } else {
    for (const d of field?.declarations || []) {
      if (d.bound && executableTileIds.has(d.source)) entries.push({ sourceId: d.source, type: d.type });
    }
  }
  for (const ds of dependentSources) {
    for (const decl of ds.declarations) entries.push({ sourceId: ds.sourceId, type: decl.type });
  }

  // ── Resolve the agreed contract from `entries` ────────────────────────────
  let contract: FilterSelectionContract | null = null;
  if (!entries.length) {
    if (!targetProblem) {
      diagnostics.push(err(
        'filter-selection-no-consumers',
        `Filter "${filter.id}" parameter {${name}} has no executable consumer declarations.`,
        { filterId: filter.id, parameter: name },
      ));
    }
  } else {
    const parsed = entries.map((e) => ({ ...e, parsed: parseParamType(e.type) }));
    const nested = parsed.filter((e) => e.parsed.isArray && e.parsed.elem?.isArray);
    if (nested.length) {
      diagnostics.push(err(
        'filter-selection-nested-array',
        `Filter "${filter.id}" parameter {${name}} declares a nested array in source(s) ` +
          `${nested.map((e) => `"${e.sourceId}" (${e.type})`).join(', ')}; nested arrays are not supported.`,
        { filterId: filter.id, parameter: name, sources: nested.map((e) => e.sourceId) },
      ));
    } else {
      const scalarEntries = parsed.filter((e) => !e.parsed.isArray);
      const arrayEntries = parsed.filter((e) => e.parsed.isArray);
      if (scalarEntries.length && arrayEntries.length) {
        diagnostics.push(err(
          'filter-selection-mixed-arity',
          `Filter "${filter.id}" parameter {${name}} mixes scalar and Array(...) consumer declarations: ` +
            `${parsed.map((e) => `"${e.sourceId}":${e.type}`).join(', ')}.`,
          { filterId: filter.id, parameter: name, sources: parsed.map((e) => e.sourceId) },
        ));
      } else if (scalarEntries.length) {
        const conflict = conflictingTypes(scalarEntries.map((e) => ({ type: e.type })));
        if (conflict) {
          diagnostics.push(err(
            'filter-selection-type-conflict',
            `Filter "${filter.id}" parameter {${name}} has conflicting consumer types: ${conflict.join(' vs ')} ` +
              `(${scalarEntries.map((e) => `"${e.sourceId}":${e.type}`).join(', ')}).`,
            { filterId: filter.id, parameter: name, types: conflict, sources: scalarEntries.map((e) => e.sourceId) },
          ));
        } else {
          contract = { array: false, type: scalarEntries[0].parsed };
        }
      } else {
        // All-array (and no nested arrays, checked above) — compare ELEMENT
        // types by their own raw (wrapper-inclusive) declaration text, the
        // same identity `conflictingTypes` uses for a bare scalar
        // declaration, so `Array(LowCardinality(UInt64))` and `Array(UInt64)`
        // conflict exactly when `LowCardinality(UInt64)` and `UInt64` would
        // (see the doc comment above — this module makes no separate
        // transparency judgment call of its own).
        const conflict = conflictingTypes(arrayEntries.map((e) => ({ type: e.parsed.elem!.raw })));
        if (conflict) {
          diagnostics.push(err(
            'filter-selection-array-element-conflict',
            `Filter "${filter.id}" parameter {${name}} has conflicting Array element types: ${conflict.join(' vs ')} ` +
              `(${arrayEntries.map((e) => `"${e.sourceId}":${e.type}`).join(', ')}).`,
            { filterId: filter.id, parameter: name, types: conflict, sources: arrayEntries.map((e) => e.sourceId) },
          ));
        } else {
          contract = { array: true, type: arrayEntries[0].parsed.elem! };
        }
      }
    }
  }

  // ── Effective selection mode, per #189's mode table (see doc comment) ────
  const rawMode = filter.selection?.mode;
  if (rawMode && rawMode !== 'single' && rawMode !== 'multiple') {
    diagnostics.push(err(
      'filter-selection-unknown-mode',
      `Filter "${filter.id}" selection.mode "${rawMode}" is not recognized; expected "single" or "multiple".`,
      { filterId: filter.id, parameter: name, mode: rawMode },
    ));
  }
  let mode: 'single' | 'multiple' | null = null;
  if (contract) {
    if (rawMode === 'multiple') {
      if (contract.array) {
        mode = 'multiple';
      } else {
        diagnostics.push(err(
          'filter-selection-mode-requires-array',
          `Filter "${filter.id}" selection.mode "multiple" requires an Array(...) consumer type for {${name}}; ` +
            `the agreed consumer type is scalar (${contract.type.raw}).`,
          { filterId: filter.id, parameter: name },
        ));
      }
    } else if (rawMode === 'single') {
      mode = 'single';
    } else if (!rawMode) {
      mode = contract.array ? 'multiple' : 'single';
    }
    // An unrecognized non-empty mode string was already diagnosed above —
    // `mode` stays null, `diagnostics.length` already guarantees the fallback.
  }

  return { contract, mode: diagnostics.length ? null : mode, diagnostics };
}

// ── Pure selection-value helpers (#189) ─────────────────────────────────────
// Empty string (`''`) is a VALID option value and a valid selection element
// everywhere below — never a sentinel for "nothing selected" (that's an empty
// ARRAY, or the field's own active/inactive flag upstream).

/**
 * Structural equality for a committed filter value: two string arrays are
 * equal element-wise (same length, same values in the same order — order
 * matters here because it's the COMMITTED array, not a set); two strings are
 * equal as strings; an array is never equal to a string, whatever its
 * contents. Anything else (`null`/`undefined`/other) falls back to `===`.
 * Pure.
 */
export function sameSelection(a: unknown, b: unknown): boolean {
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    if (av.length !== bv.length) return false;
    return av.every((v, i) => v === bv[i]);
  }
  return a === b;
}

/**
 * Canonicalize a set of selection values against the authoritative option
 * list: dedupe, drop any value with no matching option (a stale bound value
 * options refresh dropped), and order the survivors by OPTION order (never
 * `values`' own order) — the option list is authoritative for display order.
 * Never introduces a value that wasn't already in `values` — this is a
 * filter/reorder, never an auto-select. Pure.
 */
export function canonicalizeSelection(
  values: readonly string[],
  options: readonly { value: string }[],
): string[] {
  const wanted = new Set(values);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const opt of options) {
    if (wanted.has(opt.value) && !seen.has(opt.value)) {
      seen.add(opt.value);
      out.push(opt.value);
    }
  }
  return out;
}

/**
 * `reconcileSelection`'s return shape — see `reconcileSelection`'s own doc
 * comment for exactly what `deactivate`/`waveNeeded` mean.
 */
export interface SelectionReconciliation {
  value: string[];
  deactivate: boolean;
  waveNeeded: boolean;
}

/**
 * Reconcile a previously COMMITTED multiselect value against a fresh option
 * list (a Filter helper's options changed — new query run, new upstream
 * filter value) — the pure decision core behind #189's option-refresh
 * behavior. Intersects `committed` with the values still present in
 * `options`, then canonicalizes the survivors by the NEW option order
 * (`canonicalizeSelection`) — never re-introduces a value that isn't in
 * `committed` (auto-select is never this function's job).
 *
 * - `deactivate` — true iff `committed` was non-empty and the intersection is
 *   empty (every previously selected value is gone: the filter has nothing
 *   left to contribute, so the caller should deactivate it rather than send
 *   an empty selection).
 * - `waveNeeded` — true iff the SET of values changed (some committed value
 *   was dropped because it's no longer a valid option) — a caller only needs
 *   to re-run dependent sources/tiles then. A pure REORDER or label change
 *   (every committed value still present, just at new option positions) is
 *   `waveNeeded: false` even though `value`'s own array order may differ from
 *   `committed`'s.
 *
 * Pure.
 */
export function reconcileSelection(
  committed: readonly string[],
  options: readonly { value: string }[],
): SelectionReconciliation {
  const optionValues = new Set(options.map((o) => o.value));
  const committedUnique = Array.from(new Set(committed));
  const survivorsUnique = committedUnique.filter((v) => optionValues.has(v));
  const value = canonicalizeSelection(survivorsUnique, options);
  return {
    value,
    deactivate: committedUnique.length > 0 && survivorsUnique.length === 0,
    waveNeeded: survivorsUnique.length !== committedUnique.length,
  };
}
