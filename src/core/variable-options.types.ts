// Type-only contract for Dashboard variable OPTION SQL (#447 phase 2,
// ADR-0002 phase 0). Co-located with `variable-options.ts`, which owns the
// behaviour.
//
// Lives here rather than on the viewer session so that BOTH the Dashboard
// application layer (which runs the batch) and `src/ui/variable-bar.ts` (which is
// shared with the detached Data view and must not depend on the Dashboard
// application layer) can name these shapes.

/** One option a configured variable offers: the value bound into every panel
 *  query that declares the variable, and the label shown in its control.
 *  Column POSITION in the option query decides which is which — column names
 *  are never read. */
export interface VariableOption {
  value: string;
  label: string;
}

/** Why one variable's option SQL cannot run, or why its result was rejected.
 *  `code` is stable for tests and telemetry; `message` is user-facing. */
export interface VariableOptionDiagnostic {
  code: string;
  message: string;
}

/** One branch of a compiled option batch: the variable it belongs to and the
 *  SQL text that was embedded for it. */
export interface VariableOptionBranch {
  /** The exact, case-sensitive variable name — its only identity. */
  name: string;
  /** The normalized (trailing-trivia-stripped) user SQL this branch embeds. */
  sql: string;
}

/** A compiled option batch: one request for every configured variable. */
export interface VariableOptionBatch {
  /** The generated `UNION ALL` query. */
  sql: string;
  /** The branches, in the order they appear in `sql` — Variables order. */
  branches: VariableOptionBranch[];
  /** The client-side row cap for the whole request: high enough that the
   *  per-branch `LIMIT` is always the binding constraint, so a variable early in
   *  the batch can never consume the budget of one that follows it. */
  rowLimit: number;
}

/** The outcome of reading one option-batch response. */
export interface VariableOptionResult {
  /** Options per variable name, in response order, de-duplicated and capped.
   *  A requested variable that returned no rows maps to an empty array — a
   *  legal result ("zero or more rows"), not a failure. */
  byName: Map<string, VariableOption[]>;
  /** Variables whose options were cut off at the per-variable cap. */
  truncated: Set<string>;
  /** A whole-response rejection (the shape the batch itself guarantees did not
   *  arrive), or `null` when the response was readable. Per the issue, a
   *  combined-query problem is a BATCH-level failure. */
  error: VariableOptionDiagnostic | null;
}
