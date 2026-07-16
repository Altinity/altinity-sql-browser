// The shared, pure, two-phase, multi-source parameter pipeline (#173) — the
// Phase 7.0 foundation that #165 (optional filter blocks), #169 (relative
// dates), #170 (validation), #171 (history snapshots), #172 (enum controls),
// #160 (curated dashboard filters) and #175 (setup panels) plug into.
//
// Phase 1 — `analyzeParameterizedSources(sources)`: structure only, no values.
// Each source (`{id, label, kind, sql, bindPolicy}`) is split into statements
// (fixing #155: everything downstream is per-statement), each statement is
// scanned on the *analysis* materialization (#165: every optional block
// retained, so parameters inside currently-inactive blocks stay discoverable),
// and every declaration — all occurrences, via `scanParamDeclarations` — is
// recorded per field with per-source requiredness (`requiredIn`/`optionalIn`
// plus the `*Anywhere` rollups; a param can be required in one tile and
// optional in another). Cross-source type conflicts become global diagnostics.
//
// Phase 2 — `prepareParameterizedBatch(analysis, {values, active, wallNowMs,
// validationMode})`: values in, per-source verdicts out. Fixed stage order per
// source: split (from the analysis) → materialize execution view (#165 seam) →
// classify → resolve relative values (#169 seam, on `wallNowMs`) → validate
// (#170 seam, per `validationMode`) → serialize typed args (param-serialize) →
// snapshot immutable `boundParams`. Gating is per-source: one tile's invalid
// value or template error never blocks unrelated tiles.
//
// Clocks: `wallNowMs` is a *wall* clock (Date.now-class) injected separately
// from the app's performance.now-based duration clock; callers resolve one per
// rerun wave. Coalescing/debounce live in the callers — a pure function cannot
// debounce; the pipeline's contract is only "same batch → same clock".

import { splitStatements as _splitStatements, isRowReturning as _isRowReturning } from './sql-split.js';
import { scanParamDeclarations as _scanParamDeclarations } from './param-scan.js';
import { parseParamType, conflictingTypes, enumValues } from './param-type.js';
import type { ParsedParamType } from './param-type.js';
import { serializeParamValue as _serializeParamValue } from './param-serialize.js';
import { materializeOptionalBlocks, countOptionalBlocks, ALL_ACTIVE } from './optional-blocks.js';
import type { MaterializeResult } from './optional-blocks.js';
import { validateParamValue as validateTypedValue } from './param-validate.js';
import type { ParamValidationStatus } from './param-validate.js';
import {
  resolveRelativeValue as _resolveRelativeExpr,
  isDateLikeType as _isDateLikeType,
} from './relative-time.js';

// `sql-split.js` is unconverted (checkJs:false) — thin typed wrappers over the
// exact signatures this file relies on, verified against the wrapped function
// bodies (same convention `param-type.ts` uses for `clickhouse-type.js`).
const splitStatements = _splitStatements as (sql: string) => string[];
const isRowReturning = _isRowReturning as (stmt: string) => boolean;

// `param-scan.js`'s all-occurrences declaration shape (position fields
// dropped) — the same narrowed contract `optional-blocks.ts` already declares
// for the same function.
interface ParamDeclaration {
  name: string;
  type: string;
}
const scanParamDeclarations = _scanParamDeclarations as (sql: string) => ParamDeclaration[];

// `param-serialize.js` is unconverted — its `{ok:true,value} | {ok:false,
// error,structural?}` result contract, narrowed to what this file reads.
type SerializeParamResult =
  | { ok: true; value: string }
  | { ok: false; error: string; structural?: boolean };
const serializeParamValue = _serializeParamValue as (
  value: unknown,
  type: string | ParsedParamType,
  name?: string,
) => SerializeParamResult;

// `relative-time.js` is unconverted — its `{ok:true,value,matched} | {ok:
// false,error}` result contract. `nowMs` is honestly optional here: the
// resolver never dereferences it for a non-date-like type or a value that
// doesn't match the relative grammar at all (rule 6) — the only shape this
// pipeline ever calls without a pinned wall clock (see `resolveRelativeValue`
// below, and its doc comment).
type ResolveRelativeResult =
  | { ok: true; value: unknown; matched: boolean }
  | { ok: false; error: string };
const resolveRelativeExpr = _resolveRelativeExpr as (
  expr: unknown,
  type: string | ParsedParamType,
  nowMs?: number,
) => ResolveRelativeResult;
const isDateLikeType = _isDateLikeType as (type: string | ParsedParamType) => boolean;

// A source's `bindPolicy` is deliberately typed `string`, not this literal
// union — an unrecognized value (e.g. a bad Spec) must still flow through as
// a per-source config error (see `analyzeParameterizedSources`), never a type
// error. `BIND_POLICIES` itself stays `readonly string[]` rather than
// `as const` for exactly that reason: it is probed with `.includes(bindPolicy:
// string)`, and an `as const` literal-tuple type would reject that call.
export const BIND_POLICIES: readonly string[] = ['row-returning', 'all'];

// ── Stage seams ──────────────────────────────────────────────────────────────
// The two #165 materialization stages, #169's resolver, and #170's validator
// are all real now (optional-blocks.js / relative-time.js / param-validate.js).
// The optional `stages` argument overrides any of them per call — which is also
// how tests exercise the downstream classification today.

/** #165's analysis materialization: every optional block retained, markers
 *  stripped — the view all param discovery works on, so parameters inside
 *  currently-inactive blocks stay discoverable. Pure. */
export function analysisView(sql: string): string {
  return materializeOptionalBlocks(sql, ALL_ACTIVE).sql;
}

/** #165's execution materialization: only *active* optional blocks retained,
 *  per the `active` map (a block needs every one of its params active). Pure. */
export function executionView(sql: string, active: Record<string, boolean>): string {
  return materializeOptionalBlocks(sql, active).sql;
}

/** #169's relative-value resolver (`-1h` → epoch seconds), on the wave's wall
 *  clock: delegates to `relative-time.js`, which is a no-op for non-date-like
 *  declared types and for values that don't match the relative grammar at all
 *  (rule 6 — an absolute value passes through verbatim). A value that *looks*
 *  relative but fails to parse (a near miss) becomes the `{error}` sentinel
 *  `prepareParameterizedBatch` below recognizes and classifies per
 *  `validationMode` — `incomplete` (neutral, non-blocking) under 'input',
 *  hardened to `invalid` under 'execute' — the same timing model #170 uses
 *  for its own incomplete verdicts. The stage contract stays "return the
 *  resolved value" for the success case, so
 *  a caller-supplied override (see the `stages` param) can still return a
 *  plain value unchanged, exactly like the identity pass this replaced. Pure.
 */
export function resolveRelativeValue(rawValue: unknown, type: string | ParsedParamType, wallNowMs?: number): unknown {
  const r = resolveRelativeExpr(rawValue, type, wallNowMs);
  return r.ok ? r.value : { error: r.error };
}

/** The pipeline's own stage-contract verdict shape (see `validateParamValue`'s
 *  doc comment below): either one of the plain-string states, or the
 *  `{state:'invalid', reason?}` shape carrying a specific reason. */
export type LocalValidationVerdict =
  | Exclude<ParamValidationStatus, 'invalid'>
  | { state: 'invalid'; reason?: string };

/** The general stage-override contract `stages.validateParamValue` accepts: a
 *  bare state string (only `'invalid'`/`'incomplete'` are ever branched on by
 *  name — see `prepareParameterizedBatch`) or `{state, reason?}`. Deliberately
 *  wider than `LocalValidationVerdict` — a test/caller override is free to
 *  return e.g. `'ok'`, which the built-in wrapper below never actually
 *  produces itself but which reads identically to any other non-invalid,
 *  non-incomplete state at the call site. */
export type StageValidationVerdict = string | { state: string; reason?: string };

/** The input-time ('input', still typing — lenient) vs execute-time
 *  ('execute', blur/Enter/run — hardens 'incomplete' to 'invalid') validation
 *  mode threaded through `prepareParameterizedBatch`. */
export type ValidationMode = 'input' | 'execute';

/** #170's per-type validator: adapts `param-validate.js`'s `{status,
 *  reason?}` contract (`'valid'|'invalid'|'incomplete'|'unknown'`, checked
 *  against the *type*, permissive by construction) to this pipeline's stage
 *  contract — a state string `'ok'|'incomplete'|'invalid'|'unknown'` or
 *  `{state, reason?}` (a bare 'unknown', like 'valid', reads as "ok" to the
 *  caller below, which only branches on the exact 'invalid'/'incomplete'
 *  strings). `validationMode`'s incomplete→invalid hardening happens in
 *  `prepareParameterizedBatch`, not here — this stage only classifies. Pure.
 */
export function validateParamValue(resolvedValue: unknown, type: ParsedParamType, validationMode: ValidationMode): LocalValidationVerdict { // eslint-disable-line no-unused-vars
  const v = validateTypedValue(type, resolvedValue);
  return v.status === 'invalid' ? { state: 'invalid', reason: v.reason } : v.status;
}

const emptyValue = (v: unknown): boolean => v == null || v === '';
const normVerdict = (v: StageValidationVerdict): { state: string; reason?: string } =>
  (typeof v === 'string' ? { state: v } : v);

// The `{error}` sentinel `resolveRelativeValue` returns for a near-miss
// relative expression — narrowed here as a proper type guard (rather than the
// inline compound condition it replaces) so `prepareParameterizedBatch` below
// gets `resolved.error: string` without a cast. `Array.isArray` guard: an
// Array(...)-typed rawValue is itself an object and must not be mistaken for
// the sentinel (relative-time only ever touches scalar date-like types, so an
// array always comes back unchanged).
function isResolveErrorSentinel(v: unknown): v is { error: string } {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && 'error' in v;
}

// ── Phase 1: analysis ────────────────────────────────────────────────────────

/** One parameterized source as callers pass it in — a workbench tab, a
 *  dashboard tile, or a setup panel (#175). `bindPolicy` is validated (against
 *  `BIND_POLICIES`) rather than typed as the literal union — see the
 *  `BIND_POLICIES` comment above. */
export interface ParameterizedSourceInput {
  id: string;
  label?: string;
  kind?: string;
  sql: string;
  bindPolicy?: string;
}

/** One `{name:Type}` declaration occurrence, as recorded against a field
 *  during analysis: which source/statement it came from, its local type text,
 *  and whether that statement binds (per the source's `bindPolicy`). */
export interface AnalyzedDeclaration {
  source: string;
  statement: number;
  type: string;
  bound: boolean;
}

/** The distinct conflicting canonical types for a field whose declarations
 *  disagree (see `conflictingTypes` in `param-type.ts`). */
export interface FieldTypeConflict {
  types: string[];
}

/** Per-field analysis state: every declaration occurrence, per-source
 *  requiredness (`requiredIn`/`optionalIn`, deduped per source — required
 *  wins when a source has both), the `*Anywhere` rollups `fieldControls`
 *  reads for the `optional` flag, and an optional `conflict` when the
 *  declarations disagree on type (#173 acceptance). */
export interface AnalysisField {
  declarations: AnalyzedDeclaration[];
  requiredIn: string[];
  optionalIn: string[];
  requiredAnywhere: boolean;
  optionalAnywhere: boolean;
  conflict?: FieldTypeConflict;
}

/** One statement of an analyzed source: its (unmaterialized) SQL text,
 *  whether it binds under the source's `bindPolicy`, and its all-occurrences
 *  param scan (on the analysis materialization when bound). */
export interface AnalyzedStatement {
  sql: string;
  bind: boolean;
  params: ParamDeclaration[];
}

/** One analyzed source — the per-statement split `prepareParameterizedBatch`
 *  re-uses so phase 2 never re-derives it. `errors` are per-source
 *  template/config problems (bad `bindPolicy`, a malformed optional block,
 *  rule-4's block-wraps-a-whole-statement). */
export interface AnalyzedSource {
  id: string;
  label?: string;
  kind?: string;
  bindPolicy: string;
  statements: AnalyzedStatement[];
  errors: string[];
}

/** The one diagnostic kind `analyzeParameterizedSources` currently produces —
 *  a field whose declarations disagree on type (#173 acceptance). Kept as its
 *  own tagged shape (rather than folding into a broader union) so a future
 *  second diagnostic kind can be added without touching this one's fields. */
export interface TypeConflictDiagnostic {
  kind: 'type-conflict';
  name: string;
  types: string[];
  message: string;
}

/** `analyzeParameterizedSources`'s return shape — the input contract of
 *  `prepareParameterizedBatch`. */
export interface ParameterAnalysis {
  fields: Record<string, AnalysisField>;
  sources: AnalyzedSource[];
  sourceErrors: Record<string, string[]>;
  diagnostics: TypeConflictDiagnostic[];
}

/** Stage overrides for `analyzeParameterizedSources` — today just the #165
 *  analysis-materialization seam (tests use it to exercise downstream
 *  classification without the real optional-block scanner). */
export interface AnalysisStages {
  analysisView?: (sql: string) => string;
}

/**
 * Analyze a batch of parameterized sources: per-field declarations (ALL
 * occurrences), per-source requiredness, per-source template/config errors,
 * and global diagnostics (type conflicts). Values play no part here. The
 * returned object is the input contract of `prepareParameterizedBatch`; its
 * `sources` carry the per-statement split (with each statement's bind verdict
 * per the source's `bindPolicy`) so phase 2 never re-derives it.
 *
 * `bindPolicy` is the *source's*, not global: `'row-returning'` keeps #134's
 * rule (non-row-returning statements — DDL, parameterized views — pass through
 * verbatim, their placeholders unbound); `'all'` binds every statement (#175
 * setup panels).
 */
export function analyzeParameterizedSources(
  sources: ParameterizedSourceInput[] | null | undefined,
  stages: AnalysisStages = {},
): ParameterAnalysis {
  // The analysis-materialization stage defaults to this module's own
  // `analysisView`, symmetric with `prepareParameterizedBatch`'s
  // `executionView` default. (The direct `materializeOptionalBlocks` call
  // below still runs regardless — it is the *error* source for a malformed
  // block; for the default stage its `.sql` and `aView(sql)` are the same
  // bytes, one extra linear scan.)
  const aView = stages.analysisView || analysisView;
  const fields: Record<string, AnalysisField> = {};
  const fieldFor = (name: string): AnalysisField => fields[name] || (fields[name] = {
    declarations: [],
    requiredIn: [],
    optionalIn: [],
    requiredAnywhere: false,
    optionalAnywhere: false,
  });
  const sourceErrors: Record<string, string[]> = {};
  const outSources: AnalyzedSource[] = (sources || []).map((s) => {
    const errors: string[] = [];
    const bindPolicy: string = s.bindPolicy || 'row-returning';
    if (!BIND_POLICIES.includes(bindPolicy)) errors.push(`unknown bindPolicy "${s.bindPolicy}"`);
    const stmts = splitStatements(s.sql);
    // #165 rule 4: a statement living entirely inside an optional block is a
    // comment-only fragment the splitter drops — surface that as a clear error
    // instead of silently ignoring the hidden statement.
    if (countOptionalBlocks(s.sql) !== stmts.reduce((n, t) => n + countOptionalBlocks(t), 0)) {
      errors.push('optional block: a block cannot wrap a whole statement');
    }
    const statements: AnalyzedStatement[] = stmts.map((sql, statement) => {
      const bind = bindPolicy === 'all' || isRowReturning(sql);
      // #165: only bound statements materialize. A non-row-returning statement
      // passes through verbatim (rule 2) — its optional blocks stay the plain
      // comments they are, invisible to the scanner, and never validated.
      let scanSql = sql;
      // Default empty (never read unless `bind`, matching the guard below) —
      // avoids a nullable `Set | null` for a value that's only ever consulted
      // in the branch that just assigned it.
      let outside = new Set<string>();
      if (bind) {
        const mat: MaterializeResult = materializeOptionalBlocks(sql, ALL_ACTIVE);
        for (const e of mat.errors) errors.push(e);
        scanSql = aView(sql);
        // A param the raw scan sees sits outside every block (blocks are
        // comments to it) → required in this source (rule 8); one visible only
        // in the analysis view is confined to blocks → optional here (rule 9).
        outside = new Set(scanParamDeclarations(sql).map((p) => p.name));
      }
      const params = scanParamDeclarations(scanSql);
      for (const p of params) {
        const f = fieldFor(p.name);
        f.declarations.push({ source: s.id, statement, type: p.type, bound: bind });
        if (!bind) continue;
        const bucket = outside.has(p.name) ? f.requiredIn : f.optionalIn;
        if (!bucket.includes(s.id)) bucket.push(s.id);
      }
      return { sql, bind, params };
    });
    if (errors.length) sourceErrors[s.id] = errors;
    return { id: s.id, label: s.label, kind: s.kind, bindPolicy, statements, errors };
  });
  const diagnostics: TypeConflictDiagnostic[] = [];
  for (const [name, f] of Object.entries(fields)) {
    // Required wins per source (#165): a param required outside a block in ANY
    // statement of a source is required there, even if it also sits inside
    // other blocks of the same source.
    f.optionalIn = f.optionalIn.filter((id) => !f.requiredIn.includes(id));
    f.requiredAnywhere = f.requiredIn.length > 0;
    f.optionalAnywhere = f.optionalIn.length > 0;
    const types = conflictingTypes(f.declarations);
    if (types) {
      f.conflict = { types };
      diagnostics.push({
        kind: 'type-conflict',
        name,
        types,
        message: `{${name}} is declared with conflicting types: ${types.join(' vs ')}`,
      });
    }
  }
  return { fields, sources: outSources, sourceErrors, diagnostics };
}

// ── Phase 2: preparation ─────────────────────────────────────────────────────

/** The three verdict states `note` (below) ever records — the literal
 *  strings the pipeline itself hardcodes at every call site (a stage
 *  override's own return value is normalized through `normVerdict` before it
 *  ever reaches `note`). */
type NoteState = 'ok' | 'incomplete' | 'invalid';
const VERDICT_RANK: Record<NoteState, number> = { ok: 1, incomplete: 2, invalid: 3 };

/** One immutable bound-parameter snapshot (#171): `rawValue`/`resolvedValue`
 *  are whatever the stored value and resolved value actually were — a scalar
 *  or a frozen array copy — so `unknown` is the honest type for both; only
 *  `serializedValue` is pinned to the wire string. All fields are `readonly`
 *  to match the `Object.freeze` the pipeline applies to every snapshot. */
export interface BoundParamSnapshot {
  readonly name: string;
  readonly declaredType: string;
  readonly rawValue: unknown;
  readonly resolvedValue: unknown;
  readonly serializedValue: string;
}

/** One prepared statement: its materialized (or, unbound, verbatim) SQL, the
 *  `param_<name>` HTTP args, and the immutable bound-parameter snapshots.
 *  `readonly` throughout — the pipeline `Object.freeze`s every statement and
 *  its `boundParams` array (see `prepareParameterizedBatch`). */
export interface PreparedStatement {
  readonly sql: string;
  readonly args: Readonly<Record<string, string>>;
  readonly boundParams: readonly BoundParamSnapshot[];
}

/** One prepared source's per-statement verdicts: `missing`/`invalid`/`errors`
 *  are per-source-unique name lists (a name can't appear twice); `runnable`
 *  is the AND of "has statements" and "none of the three are non-empty". */
export interface PreparedSource {
  id: string;
  statements: PreparedStatement[];
  missing: string[];
  invalid: string[];
  errors: string[];
  runnable: boolean;
}

/** A field's rolled-up state across every source of the batch — see
 *  `prepareParameterizedBatch`'s doc comment for exactly what each state
 *  means. Kept as one interface with an optional `reason` (rather than a
 *  discriminated union keyed on `state`) — the same call this module's own
 *  `ParamValidationResult` (`param-validate.ts`) already made, for the same
 *  reason: a `reason` is only ever populated alongside `'invalid'`, but that
 *  pairing isn't worth the extra type ceremony for this small, uniform set of
 *  call sites. */
export interface PreparedFieldState {
  state: 'missing' | 'inactive' | 'incomplete' | 'invalid' | 'ok';
  reason?: string;
}

/** `prepareParameterizedBatch`'s return shape. */
export interface PreparedBatch {
  fields: Record<string, PreparedFieldState>;
  sources: PreparedSource[];
  diagnostics: TypeConflictDiagnostic[];
}

/** Stage overrides for `prepareParameterizedBatch` — the #165 execution-
 *  materialization seam, the #169 relative-value resolver, and the #170
 *  validator, each swappable independently (tests use this to exercise one
 *  stage in isolation). */
export interface PrepareStages {
  executionView?: (sql: string, active: Record<string, boolean>) => string;
  resolveRelativeValue?: (rawValue: unknown, type: ParsedParamType, wallNowMs?: number) => unknown;
  validateParamValue?: (resolvedValue: unknown, type: ParsedParamType, validationMode: ValidationMode) => StageValidationVerdict;
}

/** `prepareParameterizedBatch`'s options bag — see its own doc comment for
 *  what each field means. */
export interface PrepareParameterizedBatchOptions {
  values?: Record<string, unknown>;
  active?: Record<string, boolean>;
  wallNowMs?: number;
  validationMode?: ValidationMode;
  stages?: PrepareStages;
}

/**
 * Prepare an analyzed batch against concrete `values`: per-source
 * `{statements: [{sql, args, boundParams}], missing, invalid, errors,
 * runnable}` plus per-param field states and global diagnostics.
 *
 * - Serialization is **per-statement, by that statement's own (first local)
 *   declaration** — a global "first type wins" could not safely serialize a
 *   later `Array(UInt64)` occurrence from a `String`-shaped first declaration.
 * - `boundParams` are immutable snapshots (`{name, declaredType, rawValue,
 *   resolvedValue, serializedValue}`) — #171 records them after an async
 *   request finishes, when the live field may already have been edited.
 * - `errors` (template/serialization/config) are neither `missing` nor
 *   `invalid`; all three make the source not `runnable`, and none of them
 *   ever blocks a sibling source.
 * - `active` (#165) is the optional-block activation map (see
 *   `effectiveFilterActive` in state.js): inactive blocks drop out of the
 *   execution view, so their params are never bound; an *active,
 *   block-confined* param whose stored value is empty binds a real empty
 *   string instead of gating. Activation never bypasses requiredness — a
 *   param with an occurrence outside every block in a statement gates as
 *   missing there on a blank value, whatever the active map says.
 * - Field states: `missing` (empty but required somewhere in this batch's
 *   execution views) | `inactive` (does not participate in any bound execution
 *   statement) | `incomplete` (display-only; hardens to `invalid` under
 *   `validationMode: 'execute'`) | `invalid` | `ok`.
 */
export function prepareParameterizedBatch(
  analysis: ParameterAnalysis,
  opts: PrepareParameterizedBatchOptions = {},
): PreparedBatch {
  const { values = {}, active = {}, wallNowMs, validationMode = 'input', stages = {} } = opts;
  const eView = stages.executionView || executionView;
  const resolve = stages.resolveRelativeValue || resolveRelativeValue;
  const validate = stages.validateParamValue || validateParamValue;

  // Batch-wide field bookkeeping, filled during the per-source pass.
  const boundAnywhere = new Set<string>(); // names with a bound occurrence in some execution view
  const missingAnywhere = new Set<string>();
  const worst: Record<string, NoteState> = {}; // name → worst validation verdict ('ok' < 'incomplete' < 'invalid')
  const reasons: Record<string, string> = {}; // name → reason for an 'invalid' verdict, when the validator gave one
  const note = (name: string, state: NoteState, reason?: string) => {
    if (!worst[name] || VERDICT_RANK[state] > VERDICT_RANK[worst[name]]) {
      worst[name] = state;
      if (reason != null) reasons[name] = reason;
    }
  };

  const sources: PreparedSource[] = analysis.sources.map((src) => {
    const errors = src.errors.slice();
    const missing: string[] = [];
    const invalid: string[] = [];
    const statements: PreparedStatement[] = src.statements.map((st) => {
      // #134 / bindPolicy: an unbound statement passes through verbatim —
      // placeholders intact (parameterized views), no args, no snapshots.
      if (!st.bind) return Object.freeze({ sql: st.sql, args: {}, boundParams: Object.freeze([]) });
      const sql = eView(st.sql, active);
      // Re-scan the *execution* view: a param whose only occurrences sat in a
      // dropped inactive block (#165) is not bound — and not required — here.
      // The raw statement scan (blocks are comments to it) is this statement's
      // required set — same derivation as phase 1's requiredIn.
      const requiredHere = new Set(scanParamDeclarations(st.sql).map((p) => p.name));
      const args: Record<string, string> = {};
      const boundParams: BoundParamSnapshot[] = [];
      const seen = new Set<string>();
      for (const p of scanParamDeclarations(sql)) {
        // One `param_<name>` arg per statement: the statement's own first
        // declaration is the local serialization authority.
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        boundAnywhere.add(p.name);
        const type = parseParamType(p.type);
        const stored = values[p.name];
        if (emptyValue(stored) && (requiredHere.has(p.name) || !active[p.name])) {
          // A required occurrence (outside every block in THIS statement)
          // always gates as missing on a blank value — the shared activation
          // map never bypasses requiredness (#165 review finding 2).
          if (!missing.includes(p.name)) missing.push(p.name);
          missingAnywhere.add(p.name);
          continue;
        }
        // An explicitly-activated empty value binds as a real empty string
        // (#165) — distinct from inactive/missing; this bypass only ever
        // reaches block-confined params (text controls keep blank ⇒ inactive,
        // and required occurrences gated above).
        const rawValue: unknown = emptyValue(stored) ? '' : stored;
        const resolved = resolve(rawValue, type, wallNowMs);
        // #169: a near-miss relative expression (starts like one, fails to
        // parse) comes back as the `{error}` sentinel rather than a value to
        // validate. Review finding #2: this follows #170's exact incomplete→
        // invalid timing model, not an unconditional gate — under 'input'
        // mode (still typing: `-1`, `now-`, `now-1`, `now/` are all ordinary
        // keystrokes on the way to a valid expression) it's `incomplete`,
        // display-only and non-blocking, same as the type-validator's own
        // incomplete verdict below; only 'execute' mode (blur/Enter/run — see
        // #170's harden-on-commit path) hardens it to `invalid`, with the
        // resolver's own structured reason, the same way a serialization
        // failure gates below. (`isResolveErrorSentinel`'s own comment covers
        // the `Array.isArray` guard.)
        if (isResolveErrorSentinel(resolved)) {
          if (validationMode === 'execute') {
            if (!invalid.includes(p.name)) invalid.push(p.name);
            note(p.name, 'invalid', resolved.error);
          } else {
            note(p.name, 'incomplete');
          }
          continue;
        }
        const resolvedValue: unknown = resolved;
        const verdict = normVerdict(validate(resolvedValue, type, validationMode));
        const hardInvalid = verdict.state === 'invalid'
          || (verdict.state === 'incomplete' && validationMode === 'execute');
        if (hardInvalid) {
          if (!invalid.includes(p.name)) invalid.push(p.name);
          // A verdict hardened here from 'incomplete' (rather than a validator
          // that already said 'invalid') never carries a `reason` — the value
          // was never itself rejected, only its still-mid-typing state was
          // hardened by the 'execute' mode. Without a fallback the tooltip
          // silently goes blank (falls back to the field's base title,
          // hiding that anything's wrong at all) — surface a generic reason
          // instead (#170 review). This is the single spot both the var-strip
          // and the dashboard filter bar's field affordance read from.
          note(p.name, 'invalid', verdict.reason || 'Incomplete value');
          continue;
        }
        if (verdict.state === 'incomplete') {
          // Display-only while typing ('input' mode): no arg, no gate.
          note(p.name, 'incomplete');
          continue;
        }
        const ser = serializeParamValue(resolvedValue, type, p.name);
        if (!ser.ok) {
          // Serialization failures (incl. a structurally incompatible stored
          // value) are source-level errors: they block this source only —
          // `invalid`/`errors` stay exactly as before (#173 review finding).
          // But the FIELD's own rollup must not read 'ok' when the value it
          // validated against couldn't actually be sent anywhere: downgrade
          // it to 'invalid' (with the serialization error as the reason) so
          // #171/#172 consumers reading `fields[name]` don't render a
          // blocked field as fine.
          errors.push(ser.error);
          note(p.name, 'invalid', ser.error);
          continue;
        }
        note(p.name, 'ok');
        args['param_' + p.name] = ser.value;
        boundParams.push(Object.freeze({
          name: p.name,
          declaredType: p.type,
          rawValue: Array.isArray(rawValue) ? Object.freeze(rawValue.slice()) : rawValue,
          resolvedValue: Array.isArray(resolvedValue) ? Object.freeze(resolvedValue.slice()) : resolvedValue,
          serializedValue: ser.value,
        }));
      }
      return Object.freeze({ sql, args, boundParams: Object.freeze(boundParams) });
    });
    return {
      id: src.id,
      statements,
      missing,
      invalid,
      errors,
      runnable: statements.length > 0 && !missing.length && !invalid.length && !errors.length,
    };
  });

  const fields: Record<string, PreparedFieldState> = {};
  for (const name of Object.keys(analysis.fields)) {
    // A blank value that gated anywhere is `missing` regardless of the active
    // map — a required occurrence is never bypassed by activation (#165).
    if (emptyValue(values[name]) && missingAnywhere.has(name)) {
      fields[name] = { state: 'missing' };
    } else if (emptyValue(values[name]) && !active[name]) {
      fields[name] = { state: 'inactive' };
    } else if (!boundAnywhere.has(name)) {
      fields[name] = { state: 'inactive' };
    } else {
      const state = worst[name];
      fields[name] = state === 'invalid' && reasons[name] != null
        ? { state, reason: reasons[name] }
        : { state };
    }
  }
  return { fields, sources, diagnostics: analysis.diagnostics.slice() };
}

/**
 * The union of a prepared source's per-statement `args` — the shape callers
 * pass when a whole multi-statement source is sent as one HTTP request (a
 * dashboard tile) or when one merged map is convenient (the single-statement
 * workbench run). On a per-name collision the last statement wins — identical
 * output when the declarations agree; with conflicting local declarations
 * per-statement execution (runScript), which uses each statement's own `args`,
 * is the correct transport. Pure.
 */
export function mergedSourceArgs(source: PreparedSource): Record<string, string> {
  return Object.assign({}, ...source.statements.map((s) => s.args));
}

/**
 * The execution text of a whole prepared source as one request body: its
 * materialized statements re-joined on the splitter's separator. `fallback`
 * (the caller's original SQL) is returned for an empty source (comments-only
 * SQL yields no statements). Callers that want byte-identical passthrough for
 * template-free SQL should only swap this in when `hasOptionalBlocks` says the
 * source actually is a template. Pure.
 */
export function mergedSourceSql(source: PreparedSource, fallback: string = ''): string {
  return source.statements.map((s) => s.sql).join(';\n') || fallback;
}

/** One `fieldControls` entry — the ordered control list a variables strip /
 *  dashboard filter bar renders from an analysis. */
export interface FieldControl {
  name: string;
  type: string;
  optional: boolean;
  conflict?: string[];
}

/**
 * The ordered control list a variables strip / dashboard filter bar renders
 * from an analysis (#165): one entry per field with at least one *bound*
 * declaration (a param confined to DDL — e.g. a parameterized view — is never
 * substituted, so it gets no input), in first-appearance order. `type` is the
 * first bound declaration's; `optional` is true when no source requires the
 * param (it appears only inside optional blocks wherever it binds). A field
 * whose declarations disagree on the type (#173 acceptance: the `type-conflict`
 * diagnostic) additionally carries `conflict` — the distinct normalized types,
 * in first-seen order — so both rendering surfaces can degrade the control and
 * surface the disagreement (see `fieldControlKind`). Pure.
 */
export function fieldControls(analysis: ParameterAnalysis): FieldControl[] {
  const out: FieldControl[] = [];
  for (const [name, f] of Object.entries(analysis.fields)) {
    const bound = f.declarations.find((d) => d.bound);
    if (!bound) continue;
    out.push({
      name,
      type: bound.type,
      optional: !f.requiredAnywhere,
      ...(f.conflict ? { conflict: f.conflict.types } : {}),
    });
  }
  return out;
}

/** `fieldControlKind`'s return shape — which control a `fieldControls` entry
 *  renders, and (for `'enum'`) the member list to offer. */
export interface FieldControlKindResult {
  kind: 'enum' | 'date' | 'text';
  enumOptions: string[] | null;
}

/**
 * Which control a `fieldControls` entry renders — the enum > date-like >
 * plain-text priority the workbench var-strip and the dashboard filter bar
 * previously each duplicated. `inferredEnumOptions` is the workbench's
 * optional #172 v2 tier (a schema-cache-inferred member list for a
 * String-typed param); the declared type's own Enum members always win over
 * it. A `conflict`ed field (#173 acceptance) always gets the plain text
 * control: with disagreeing declarations there is no single authoritative
 * type to specialize the control on — the value still binds per-statement by
 * each statement's own local declaration, but the UI must not pretend one
 * declaration's enum members / date presets speak for all of them. Pure.
 */
export function fieldControlKind(
  field: { type: string; conflict?: string[] },
  inferredEnumOptions: string[] | null = null,
): FieldControlKindResult {
  if (field.conflict) return { kind: 'text', enumOptions: null };
  const enumOptions = enumValues(field.type) || inferredEnumOptions;
  if (enumOptions) return { kind: 'enum', enumOptions };
  if (isDateLikeType(field.type)) return { kind: 'date', enumOptions: null };
  return { kind: 'text', enumOptions: null };
}
