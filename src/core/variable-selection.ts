// Pure value-side helpers for an option-backed Dashboard variable whose declared
// type is `Array(scalar T)` — the multi-select restored from #189/PR #364 onto
// the inferred-Variables model (#447).
//
// Only the three value helpers came back. #189's other half — `resolveFilterSelection`
// / `gatherExecutableConsumers`, the `selection.mode` override, explicit target
// lists — was the CURATED filter model's contract resolver and has no meaning
// here: a variable is inferred from panel SQL, binds by exact name to every
// panel that declares it, and its multi-ness is read straight off its declared
// type by `multiSelectElementType` (`param-type.ts`). There is no persisted
// selection mode to resolve, so this module is named for what survived rather
// than reviving `filter-selection.ts`.
//
// Empty string (`''`) is a VALID option value and a valid selection element
// throughout — never a sentinel for "nothing selected". Activation is carried by
// the field's own `active` flag, and the Dashboard's single unset form is a
// scalar `''` (see `dashboard-viewer-session.ts`'s `UNSET_VALUE`).

/**
 * Structural equality for two selections: same length, same values, in the same
 * ORDER — order matters because both sides are already canonicalized against
 * one option list, so a difference in order IS a difference in the committed
 * value.
 *
 * Deliberately narrower than #189's original, which took `unknown` and had
 * array-vs-string and scalar-vs-scalar arms. Those existed for the error-mode
 * raw-string fallback commit, which this model has no path to — every caller
 * here holds a `string[]`. Pure.
 */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Canonicalize a set of selection values against the authoritative option list:
 * dedupe, drop any value with no matching option (a stale bound value an option
 * refresh removed), and order the survivors by OPTION order — never `values`'
 * own order, because the option list is authoritative for display order.
 *
 * Never introduces a value that was not already in `values`: this is a
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

/** `reconcileSelection`'s return shape — see its doc comment for exactly what
 *  `deactivate`/`waveNeeded` mean. */
export interface SelectionReconciliation {
  value: string[];
  deactivate: boolean;
  waveNeeded: boolean;
}

/**
 * Reconcile a previously COMMITTED selection against a fresh option list (the
 * batch re-ran on a Dashboard refresh). Intersects `committed` with the values
 * still present in `options`, then canonicalizes the survivors by the NEW option
 * order — never re-introducing a value that is not in `committed`, because
 * auto-select is never this function's job.
 *
 * - `deactivate` — true iff `committed` was non-empty and the intersection is
 *   empty: every previously selected value is gone, so the variable has nothing
 *   left to contribute and the caller returns it to unset rather than binding an
 *   empty selection.
 * - `waveNeeded` — true iff the SET of values changed (some committed value was
 *   dropped because it is no longer a valid option); only then must the caller
 *   re-run the panels that declare this variable. A pure REORDER or a
 *   label-only change is `waveNeeded: false` even though `value`'s array order
 *   may differ from `committed`'s.
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
  return {
    value: canonicalizeSelection(survivorsUnique, options),
    deactivate: committedUnique.length > 0 && survivorsUnique.length === 0,
    waveNeeded: survivorsUnique.length !== committedUnique.length,
  };
}
