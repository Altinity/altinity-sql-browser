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
import { parseParamType, conflictingTypes, enumValues } from './param-type.js';
import { serializeParamValue } from './param-serialize.js';
import { materializeOptionalBlocks, countOptionalBlocks, ALL_ACTIVE } from './optional-blocks.js';
import { validateParamValue as validateTypedValue } from './param-validate.js';
import { resolveRelativeValue as resolveRelativeExpr, isDateLikeType } from './relative-time.js';

export const BIND_POLICIES = ['row-returning', 'all'];

// ── Stage seams ──────────────────────────────────────────────────────────────
// The two #165 materialization stages, #169's resolver, and #170's validator
// are all real now (optional-blocks.js / relative-time.js / param-validate.js).
// The optional `stages` argument overrides any of them per call — which is also
// how tests exercise the downstream classification today.

/** #165's analysis materialization: every optional block retained, markers
 *  stripped — the view all param discovery works on, so parameters inside
 *  currently-inactive blocks stay discoverable. Pure. */
export function analysisView(sql) {
  return materializeOptionalBlocks(sql, ALL_ACTIVE).sql;
}

/** #165's execution materialization: only *active* optional blocks retained,
 *  per the `active` map (a block needs every one of its params active). Pure. */
export function executionView(sql, active) {
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
export function resolveRelativeValue(rawValue, type, wallNowMs) {
  const r = resolveRelativeExpr(rawValue, type, wallNowMs);
  return r.ok ? r.value : { error: r.error };
}

/** #170's per-type validator: adapts `param-validate.js`'s `{status,
 *  reason?}` contract (`'valid'|'invalid'|'incomplete'|'unknown'`, checked
 *  against the *type*, permissive by construction) to this pipeline's stage
 *  contract — a state string `'ok'|'incomplete'|'invalid'|'unknown'` or
 *  `{state, reason}` (a bare 'unknown', like 'valid', reads as "ok" to the
 *  caller below, which only branches on the exact 'invalid'/'incomplete'
 *  strings). `validationMode`'s incomplete→invalid hardening happens in
 *  `prepareParameterizedBatch`, not here — this stage only classifies. Pure.
 */
export function validateParamValue(resolvedValue, type, validationMode) { // eslint-disable-line no-unused-vars
  const v = validateTypedValue(type, resolvedValue);
  return v.status === 'invalid' ? { state: 'invalid', reason: v.reason } : v.status;
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
  // The analysis-materialization stage defaults to this module's own
  // `analysisView`, symmetric with `prepareParameterizedBatch`'s
  // `executionView` default. (The direct `materializeOptionalBlocks` call
  // below still runs regardless — it is the *error* source for a malformed
  // block; for the default stage its `.sql` and `aView(sql)` are the same
  // bytes, one extra linear scan.)
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
    const stmts = splitStatements(s.sql);
    // #165 rule 4: a statement living entirely inside an optional block is a
    // comment-only fragment the splitter drops — surface that as a clear error
    // instead of silently ignoring the hidden statement.
    if (countOptionalBlocks(s.sql) !== stmts.reduce((n, t) => n + countOptionalBlocks(t), 0)) {
      errors.push('optional block: a block cannot wrap a whole statement');
    }
    const statements = stmts.map((sql, statement) => {
      const bind = bindPolicy === 'all' || isRowReturning(sql);
      // #165: only bound statements materialize. A non-row-returning statement
      // passes through verbatim (rule 2) — its optional blocks stay the plain
      // comments they are, invisible to the scanner, and never validated.
      let scanSql = sql;
      let outside = null;
      if (bind) {
        const mat = materializeOptionalBlocks(sql, ALL_ACTIVE);
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
  const diagnostics = [];
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
      // The raw statement scan (blocks are comments to it) is this statement's
      // required set — same derivation as phase 1's requiredIn.
      const requiredHere = new Set(scanParamDeclarations(st.sql).map((p) => p.name));
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
        const rawValue = emptyValue(stored) ? '' : stored;
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
        // failure gates below. `Array.isArray` guard: an Array(...)-typed
        // rawValue is itself an object and must not be mistaken for the
        // sentinel (relative-time only ever touches scalar date-like types,
        // so an array always comes back unchanged).
        if (resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved) && 'error' in resolved) {
          if (validationMode === 'execute') {
            if (!invalid.includes(p.name)) invalid.push(p.name);
            note(p.name, 'invalid', resolved.error);
          } else {
            note(p.name, 'incomplete');
          }
          continue;
        }
        const resolvedValue = resolved;
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

  const fields = {};
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
export function mergedSourceArgs(source) {
  return Object.assign({}, ...source.statements.map((s) => s.args));
}

/**
 * The execution text of a whole prepared source as one request body: its
 * materialized statements re-joined on the splitter's separator. `fallback`
 * (the caller's original SQL) is returned for an empty source (comments-only
 * SQL yields no statements). Callers that want byte-identical passthrough for
 * template-free SQL should only swap this in when `hasOptionalBlocks` says the
 * source actually is a template. Pure.
 * @param {{statements: {sql: string}[]}} source a prepared source
 * @param {string} [fallback]
 */
export function mergedSourceSql(source, fallback = '') {
  return source.statements.map((s) => s.sql).join(';\n') || fallback;
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
 * @param {ReturnType<typeof analyzeParameterizedSources>} analysis
 * @returns {{name: string, type: string, optional: boolean, conflict?: string[]}[]}
 */
export function fieldControls(analysis) {
  const out = [];
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
 * @param {{type: string, conflict?: string[]}} field a `fieldControls` entry
 * @param {string[]|null} [inferredEnumOptions]
 * @returns {{kind: 'enum'|'date'|'text', enumOptions: string[]|null}}
 */
export function fieldControlKind(field, inferredEnumOptions = null) {
  if (field.conflict) return { kind: 'text', enumOptions: null };
  const enumOptions = enumValues(field.type) || inferredEnumOptions;
  if (enumOptions) return { kind: 'enum', enumOptions };
  if (isDateLikeType(field.type)) return { kind: 'date', enumOptions: null };
  return { kind: 'text', enumOptions: null };
}
