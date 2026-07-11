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

import { splitStatements, isRowReturning } from './sql-split.js';
import { scanParamDeclarations } from './param-scan.js';
import { parseParamType, conflictingTypes } from './param-type.js';
import { serializeParamValue } from './param-serialize.js';

export const BIND_POLICIES = ['row-returning', 'all'];

// ── Stage seams ──────────────────────────────────────────────────────────────
// Shipped as identity/unknown passes; the named issues replace them (or inject
// richer implementations through the optional `stages` argument, which is also
// how tests exercise the downstream classification today).

/** #165's analysis materialization: every optional block retained. Identity
 *  until #165 lands. Pure. */
export function analysisView(sql) {
  return sql;
}

/** #165's execution materialization: only *active* optional blocks retained
 *  (per the `active` map). Identity until #165 lands. Pure. */
export function executionView(sql, active) { // eslint-disable-line no-unused-vars
  return sql;
}

/** #169's relative-value resolver (`-1h` → epoch seconds), on the wave's wall
 *  clock. Identity until #169 lands. Pure. */
export function resolveRelativeValue(rawValue, type, wallNowMs) { // eslint-disable-line no-unused-vars
  return rawValue;
}

/** #170's per-type validator. Returns `'unknown'` (not validated — treated as
 *  ok for gating) until #170 lands; the contract is a state string
 *  `'ok' | 'invalid' | 'incomplete' | 'unknown'` or `{state, reason}`. Pure. */
export function validateParamValue(resolvedValue, type, validationMode) { // eslint-disable-line no-unused-vars
  return 'unknown';
}

const emptyValue = (v) => v == null || v === '';
const normVerdict = (v) => (typeof v === 'string' ? { state: v } : v);

// ── Phase 1: analysis ────────────────────────────────────────────────────────

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
 * @param {{id: string, label?: string, kind?: string, sql: string,
 *          bindPolicy?: string}[]} sources
 * @param {{analysisView?: Function}} [stages]
 */
export function analyzeParameterizedSources(sources, stages = {}) {
  const aView = stages.analysisView || analysisView;
  const fields = {};
  const fieldFor = (name) => fields[name] || (fields[name] = {
    declarations: [],
    requiredIn: [],
    optionalIn: [],
    requiredAnywhere: false,
    optionalAnywhere: false,
  });
  const sourceErrors = {};
  const outSources = (sources || []).map((s) => {
    const errors = [];
    const bindPolicy = s.bindPolicy || 'row-returning';
    if (!BIND_POLICIES.includes(bindPolicy)) errors.push(`unknown bindPolicy "${s.bindPolicy}"`);
    const statements = splitStatements(s.sql).map((sql, statement) => {
      const bind = bindPolicy === 'all' || isRowReturning(sql);
      const params = scanParamDeclarations(aView(sql));
      for (const p of params) {
        const f = fieldFor(p.name);
        f.declarations.push({ source: s.id, statement, type: p.type, bound: bind });
        // v1 requiredness: every bound occurrence is required; `optionalIn`
        // fills in when #165's optional blocks land (a param confined to an
        // optional block is optional in that source).
        if (bind && !f.requiredIn.includes(s.id)) f.requiredIn.push(s.id);
      }
      return { sql, bind, params };
    });
    if (errors.length) sourceErrors[s.id] = errors;
    return { id: s.id, label: s.label, kind: s.kind, bindPolicy, statements, errors };
  });
  const diagnostics = [];
  for (const [name, f] of Object.entries(fields)) {
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

const VERDICT_RANK = { ok: 1, incomplete: 2, invalid: 3 };

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
 * - Field states: `missing` (empty but required somewhere in this batch's
 *   execution views) | `inactive` (does not participate in any bound execution
 *   statement) | `incomplete` (display-only; hardens to `invalid` under
 *   `validationMode: 'execute'`) | `invalid` | `ok`.
 * @param {ReturnType<typeof analyzeParameterizedSources>} analysis
 * @param {{values?: Object, active?: Object, wallNowMs?: number,
 *          validationMode?: 'input'|'execute',
 *          stages?: {executionView?: Function, resolveRelativeValue?: Function,
 *                    validateParamValue?: Function}}} [opts]
 */
export function prepareParameterizedBatch(analysis, opts = {}) {
  const { values = {}, active = {}, wallNowMs, validationMode = 'input', stages = {} } = opts;
  const eView = stages.executionView || executionView;
  const resolve = stages.resolveRelativeValue || resolveRelativeValue;
  const validate = stages.validateParamValue || validateParamValue;

  // Batch-wide field bookkeeping, filled during the per-source pass.
  const boundAnywhere = new Set(); // names with a bound occurrence in some execution view
  const missingAnywhere = new Set();
  const worst = {}; // name → worst validation verdict ('ok' < 'incomplete' < 'invalid')
  const reasons = {}; // name → reason for an 'invalid' verdict, when the validator gave one
  const note = (name, state, reason) => {
    if (!worst[name] || VERDICT_RANK[state] > VERDICT_RANK[worst[name]]) {
      worst[name] = state;
      if (reason != null) reasons[name] = reason;
    }
  };

  const sources = analysis.sources.map((src) => {
    const errors = src.errors.slice();
    const missing = [];
    const invalid = [];
    const statements = src.statements.map((st) => {
      // #134 / bindPolicy: an unbound statement passes through verbatim —
      // placeholders intact (parameterized views), no args, no snapshots.
      if (!st.bind) return Object.freeze({ sql: st.sql, args: {}, boundParams: Object.freeze([]) });
      const sql = eView(st.sql, active);
      // Re-scan the *execution* view: a param whose only occurrences sat in a
      // dropped inactive block (#165) is not bound — and not required — here.
      const args = {};
      const boundParams = [];
      const seen = new Set();
      for (const p of scanParamDeclarations(sql)) {
        // One `param_<name>` arg per statement: the statement's own first
        // declaration is the local serialization authority.
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        boundAnywhere.add(p.name);
        const type = parseParamType(p.type);
        const rawValue = values[p.name];
        if (emptyValue(rawValue)) {
          if (!missing.includes(p.name)) missing.push(p.name);
          missingAnywhere.add(p.name);
          continue;
        }
        const resolvedValue = resolve(rawValue, type, wallNowMs);
        const verdict = normVerdict(validate(resolvedValue, type, validationMode));
        const hardInvalid = verdict.state === 'invalid'
          || (verdict.state === 'incomplete' && validationMode === 'execute');
        if (hardInvalid) {
          if (!invalid.includes(p.name)) invalid.push(p.name);
          note(p.name, 'invalid', verdict.reason);
          continue;
        }
        if (verdict.state === 'incomplete') {
          // Display-only while typing ('input' mode): no arg, no gate.
          note(p.name, 'incomplete');
          continue;
        }
        note(p.name, 'ok');
        const ser = serializeParamValue(resolvedValue, type, p.name);
        if (!ser.ok) {
          // Serialization failures (incl. a structurally incompatible stored
          // value) are source-level errors: they block this source only.
          errors.push(ser.error);
          continue;
        }
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

  const fields = {};
  for (const name of Object.keys(analysis.fields)) {
    if (emptyValue(values[name])) {
      fields[name] = { state: missingAnywhere.has(name) ? 'missing' : 'inactive' };
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
export function mergedSourceArgs(source) {
  return Object.assign({}, ...source.statements.map((s) => s.args));
}
