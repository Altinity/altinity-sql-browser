// Dashboard variable OPTION SQL (#447 phase 2) — the whole contract for the
// optional, Dashboard-local query that turns a variable's automatic direct input
// into a single-select.
//
// A configured variable stores one embeddable read query returning two String
// columns: value, then label. COLUMN POSITION decides meaning; column names are
// never read. Every configured variable on a Dashboard is compiled into ONE
// `UNION ALL` request per refresh, so N configured variables still cost one round
// trip.
//
// Four separable jobs, all pure:
//
//   optionSqlDiagnostics   what can be rejected WITHOUT a server, per variable
//   compileVariableOptionBatch   the deterministic one-request compiler
//   readVariableOptionBatch      positional response reader + partitioner
//   compileOptionProbe/validateOptionColumns   the single-variable Run path (#465)
//
// The division of labour between local and server-side rejection is the issue's
// own: a problem the app can see in the SQL text is a per-variable diagnostic
// that keeps the variable out of the batch entirely, while a problem only
// ClickHouse can see (a branch whose arity disagrees with its siblings, a
// genuinely broken query) fails the COMBINED request and is reported as a
// batch-level failure. Narrowing a batch-level failure to the branch at fault
// means running that one variable's query on its own, where the response
// metadata describes that query alone — which is what a variable's own
// main-editor tab and the ordinary Run action are for (#457/#465):
// `compileOptionProbe` embeds the SQL exactly as a batch branch would (so Run
// cannot pass what the batch would reject) but drops the branch tag, and
// `validateOptionColumns` reads that probe's own, unmerged response metadata —
// the one place the "exactly two String columns" rule is checkable at all.
//
// Deliberately NOT here: cascading/dependent option queries. Option SQL may not
// reference `{name:Type}` parameters at all in this issue, which is what keeps
// this a compiler and a reader rather than a scheduler with a dependency graph.

import { splitStatements, leadingKeyword } from './sql-split.js';
import { scanSpans } from './sql-spans.js';
import { detectSqlFormat, detectSqlOutfile, sqlString, stripTrailingTrivia } from './format.js';
import { scanParamDeclarations } from './param-scan.js';
import { analysisView } from './param-pipeline.js';
import { hasOptionalBlocks } from './optional-blocks.js';
import { parseClickHouseType, analyzeTypeModifiers } from './clickhouse-type.js';
import { isCompoundParamType, multiSelectElementType } from './param-type.js';
import type { DashboardVariable } from './dashboard-variables.types.js';
import type {
  VariableOption, VariableOptionBatch, VariableOptionBranch, VariableOptionDiagnostic,
  VariableOptionResult,
} from './variable-options.types.js';

export type {
  VariableOption, VariableOptionBatch, VariableOptionBranch, VariableOptionDiagnostic,
  VariableOptionResult,
} from './variable-options.types.js';

// ── Bounds ───────────────────────────────────────────────────────────────────
// Inherited verbatim from the deleted curated-filter runtime (`FILTER_OPTION_CAP`
// / `FILTER_RESULT_BYTE_CAP`, removed in phase 1) so the numbers a Dashboard has
// always enforced stay traceable across the model change.

/** Options kept per variable. Also emitted as each branch's own SQL `LIMIT`
 *  (+1, so the cap can be DETECTED rather than silently reached), which is what
 *  makes the bound per-variable instead of first-come-first-served. */
export const VARIABLE_OPTION_CAP = 1000;

/** `max_result_bytes` for the whole compiled request. */
export const VARIABLE_OPTION_BYTE_CAP = 10_000_000;

// The three columns every branch projects. Naming them EXPLICITLY (rather than
// letting `*` pass the user's own column names through) is what makes the response
// readable at all:
//
//   - the streaming transport sends each row as a JSON OBJECT keyed by column
//     name, so two identically-named columns collapse on parse — and
//     `SELECT environment, environment FROM environments`, the option contract's
//     own documented example, is exactly that shape;
//   - in a `UNION ALL` the result column names come from the FIRST branch alone,
//     so one branch with a duplicate name silently rewrites a LATER branch's value
//     into its label. Verified against ClickHouse 26.6 before this projection
//     existed.
//
// `tupleElement(tuple(*), n)` takes the user's columns BY POSITION, which is what
// the contract specifies ("column position defines meaning; column names do not"),
// and gives them names that cannot collide. Both functions have existed since
// ClickHouse 20.4, so this needs no version gate and no transport change — the
// alternative, a positional wire format, first shipped in 25.2 and would have made
// the whole feature fail on anything older.
export const VARIABLE_NAME_COLUMN = '__variable_name';
export const VARIABLE_VALUE_COLUMN = '__variable_value';
export const VARIABLE_LABEL_COLUMN = '__variable_label';

/** The three columns every compiled branch projects, by position. */
const BATCH_COLUMN_COUNT = 3;

/** Rows fetched per variable: the cap plus one, so hitting the cap is
 *  DETECTABLE rather than silently indistinguishable from "exactly that many". */
const BRANCH_LIMIT = VARIABLE_OPTION_CAP + 1;

/** Wrap already-normalized user SQL as a bounded subquery — the embedding every
 *  branch of the combined request shares. `)` deliberately sits on its own line:
 *  a user query ending in `-- note` would otherwise comment out whatever
 *  followed it. */
const nestBounded = (sql: string): string => `(\n${sql}\n) LIMIT ${BRANCH_LIMIT}`;

const diagnostic = (code: string, message: string): VariableOptionDiagnostic => ({ code, message });

// ── Local (no-server) validation ─────────────────────────────────────────────

/**
 * The SQL text that should actually be embedded for a stored option query:
 * trailing whitespace, comments and `;` removed.
 *
 * The issue requires trailing-semicolon handling to be deterministic, and this is
 * the "strip it" half of that choice. It has to be exact rather than a regex,
 * because the text is embedded inside `( … )`: `SELECT 1;;`, `SELECT 1; -- note`
 * and `SELECT 1 -- note` each leave something behind that a naive `/;\s*$/`
 * misses and that turns the whole generated batch into a syntax error.
 * `stripTrailingTrivia` (format.ts) already walks spans backwards for exactly
 * this, and deliberately refuses to strip an UNTERMINATED block comment — so
 * malformed SQL stays malformed rather than being silently repaired into
 * something that runs.
 */
export const normalizeOptionSql = (sql: string): string => stripTrailingTrivia(sql).trim();

/**
 * Every reason one variable's option SQL cannot be sent, decided from the text
 * alone. Empty when the SQL is locally acceptable — which is NOT a promise that
 * it runs, only that nothing is knowably wrong with it yet.
 *
 * Returns ALL findings rather than the first, so a caller can show a query's
 * complete story instead of one problem at a time.
 */
export function optionSqlDiagnostics(sql?: string | null): VariableOptionDiagnostic[] {
  const raw = String(sql ?? '');
  const text = normalizeOptionSql(raw);
  if (text === '') {
    // Not an error anywhere it is reachable: blank option SQL is how a variable
    // stays on direct input, and `normalizeVariableSql` removes the stored
    // configuration entirely. Reported so a caller validating a draft (an empty
    // variable tab) has something to say.
    return [diagnostic('variable-option-sql-empty', 'Option SQL is empty. Leave it blank to type values directly instead.')];
  }
  const out: VariableOptionDiagnostic[] = [];
  const statements = splitStatements(text);
  if (statements.length !== 1) {
    out.push(diagnostic('variable-option-statement-count',
      'Option SQL must be one statement.'));
  } else {
    // Stricter than `isRowReturning`, which also admits SHOW/DESC/EXISTS/VALUES/
    // EXPLAIN. The contract is one EMBEDDABLE read query, and those cannot be
    // nested as a subquery at all — `SELECT count() FROM (SHOW TABLES)` is a
    // ClickHouse syntax error, so admitting them here would only move the
    // failure into the combined batch, where it takes every other variable down
    // with it.
    const keyword = leadingKeyword(statements[0]).toUpperCase();
    if (keyword !== 'SELECT' && keyword !== 'WITH') {
      out.push(diagnostic('variable-option-not-select',
        'Option SQL must be a SELECT (or WITH … SELECT) query.'));
    }
  }
  // An unterminated string/comment span. `stripTrailingTrivia` deliberately
  // refuses to strip an unclosed comment, so without this the text goes straight
  // into the batch and the open span swallows the closing paren, the `LIMIT` and
  // EVERY FOLLOWING BRANCH — one variable's typo takes the whole Dashboard's
  // options down. Knowable from the text alone, which is exactly what local
  // validation is for.
  if ([...scanSpans(text)].some((span) => span.kind !== 'code' && span.closed === false)) {
    out.push(diagnostic('variable-option-unterminated',
      'Option SQL has an unterminated string or comment.'));
  }
  // The generated branch tag occupies this name. A user query projecting it too
  // makes ClickHouse reject the whole batch (AMBIGUOUS_COLUMN_NAME, verified on
  // 26.6) — a confusing failure for every other variable, so it is caught here.
  if (new RegExp(`\\b${VARIABLE_NAME_COLUMN}\\b`).test(text)) {
    out.push(diagnostic('variable-option-reserved-column',
      `Option SQL cannot use the name ${VARIABLE_NAME_COLUMN}: it is reserved for the generated batch.`));
  }
  if (detectSqlFormat(text)) {
    out.push(diagnostic('variable-option-format',
      'Option SQL cannot include a FORMAT clause.'));
  }
  if (detectSqlOutfile(text)) {
    out.push(diagnostic('variable-option-outfile',
      'Option SQL cannot include an INTO OUTFILE clause.'));
  }
  // Scan the ANALYSIS view of the RAW text — the same all-blocks-active
  // materialization `inferDashboardVariables` scans (see its header). Two
  // distinct traps, both of which hide a placeholder from a plain scan of the
  // normalized text:
  //   - a `{name:Type}` inside a `/*[ … ]*/` optional block (#165) sits in what a
  //     raw lexical scan treats as a block comment, so `analysisView` is needed
  //     to see it at all;
  //   - a block that TRAILS the query is stripped outright by `normalizeOptionSql`
  //     (it is a closed comment span), so scanning the normalized text would let
  //     `SELECT a, b FROM t /*[ WHERE c = {country:String} ]*/` pass the
  //     no-cascading rule — and the block's content would then be silently
  //     dropped from what actually runs.
  const declarations = scanParamDeclarations(analysisView(raw));
  if (declarations.length) {
    out.push(diagnostic('variable-option-parameterized',
      'Variable option queries cannot reference Dashboard variables yet.'));
  } else if (hasOptionalBlocks(raw)) {
    // A `/*[ … ]*/` block exists to be switched on by a parameter, and option SQL
    // may not have parameters — so a block here can never activate. Rejected
    // rather than ignored because it does not merely do nothing: the block is a
    // comment to everything downstream, so its content is silently dropped from
    // what actually runs, and a trailing one is stripped outright by
    // `normalizeOptionSql`. Reported only when the parameter rule did not already
    // fire, so a block CONTAINING a parameter gets the one message that matters.
    out.push(diagnostic('variable-option-optional-block',
      'Variable option queries cannot use optional /*[ … ]*/ blocks: they are activated by '
      + 'a parameter, and option SQL cannot have parameters.'));
  }
  return out;
}

/** True when this variable's stored option SQL is locally acceptable — i.e. it is
 *  configured AND nothing in `optionSqlDiagnostics` rejects it. */
const isRunnableOptionSql = (sql: string | null): boolean =>
  sql !== null && optionSqlDiagnostics(sql).length === 0;

/**
 * Whether a variable's declared TYPE can be backed by an option list at all.
 *
 * A scalar takes the single-select; an `Array` of a scalar takes the restored
 * multi-select, where the SAME two-String-column option rows are the pool a user
 * picks several values from — the array-ness is about how selections are
 * COMBINED into one bound value, never about the row shape, so nothing in the
 * compiler or the reader varies with it.
 *
 * Every other container (`Tuple`/`Map`/`Nested`, and a nested
 * `Array(Array(T))`) still renders no select: a flat value/label list cannot
 * supply one of those, so running its option SQL would be work for a control
 * that never appears — and a broken one could fail the combined query and take
 * every OTHER variable's options down with it. Same rule, same reason, as
 * conflicted and orphaned.
 */
const optionEligibleType = (type: string): boolean =>
  !isCompoundParamType(type) || multiSelectElementType(type) !== null;

/**
 * The variables that belong in a refresh's option batch: inferred,
 * type-consistent (`status === 'active'`, which excludes both a CONFLICTED name
 * and an ORPHANED configuration), of an option-backable type, configured with
 * non-empty option SQL, and locally acceptable.
 *
 * Order is the caller's — `inferDashboardVariables`' inference order — and every
 * consumer follows it, so the compiled branch order is the Variables order.
 */
export const optionBatchVariables = (
  variables: readonly DashboardVariable[],
): DashboardVariable[] => variables.filter(
  (variable) => variable.status === 'active'
    && optionEligibleType(variable.type ?? '')
    && isRunnableOptionSql(variable.sql),
);

// ── The compiler ─────────────────────────────────────────────────────────────

/**
 * Compile every configured variable's option SQL into ONE request, or `null`
 * when there is nothing to run (no eligible variable → no request at all, never
 * an empty query).
 *
 * One branch per variable, `UNION ALL`-joined in Variables order:
 *
 * ```sql
 * SELECT 'country' AS __variable_name, * FROM (
 * <user sql>
 * ) LIMIT 1001
 * ```
 *
 * Properties that matter, each load-bearing:
 *
 *   - the branch tag is a SQL string literal built by the shared `sqlString`
 *     escaper, never interpolated raw — a variable name is user-authored text;
 *   - user SQL is always nested as a subquery and never rewritten;
 *   - `)` sits on its own line, so a user query ending in `-- note` cannot
 *     comment out the rest of the template (which would break the whole batch,
 *     not just that branch);
 *   - the `LIMIT` binds PER BRANCH, so one large option list cannot crowd out
 *     the variables after it;
 *   - every branch projects the same three columns in the same order, which is
 *     what lets the response be read positionally.
 *
 * `rowLimit` is deliberately generous: the per-branch `LIMIT` is the real bound,
 * and the transport cap exists only as a backstop. Sizing it to the sum of the
 * branch limits is what stops the client-side trim from starving late branches —
 * a single shared `CAP + 1` would let variable #1 consume the entire budget and
 * leave every later variable looking as though it returned nothing.
 */
export function compileVariableOptionBatch(
  variables: readonly DashboardVariable[],
): VariableOptionBatch | null {
  const eligible = optionBatchVariables(variables);
  if (!eligible.length) return null;
  const branches: VariableOptionBranch[] = eligible.map((variable) => ({
    name: variable.name,
    // `!`: `optionBatchVariables` admits only variables whose `sql` is non-null.
    sql: normalizeOptionSql(variable.sql!),
  }));
  const sql = branches.map((branch) =>
    `SELECT ${sqlString(branch.name)} AS ${VARIABLE_NAME_COLUMN},`
    + `\n       tupleElement(tuple(*), 1) AS ${VARIABLE_VALUE_COLUMN},`
    + `\n       tupleElement(tuple(*), 2) AS ${VARIABLE_LABEL_COLUMN}`
    + `\nFROM ${nestBounded(branch.sql)}`)
    .join('\nUNION ALL\n');
  return { sql, branches, rowLimit: branches.length * BRANCH_LIMIT + 1 };
}

/**
 * The query a `dashboard-variable` tab's Run action executes (#465): ONE
 * variable's option SQL, embedded exactly as a batch branch embeds it but
 * without the branch tag.
 *
 * Sharing `nestBounded` with the compiler is the point — Run must not pass SQL
 * the batch would reject, and the nesting is the one transformation that can
 * make an otherwise-valid query fail. Dropping the tag column keeps the response
 * metadata describing the USER's own columns, which is what makes the "exactly
 * two String columns" rule checkable here and nowhere else: in the combined batch
 * `UNION ALL` reports one merged column list for every branch.
 *
 * Bounded like a branch, so Run cannot pull an unbounded result either.
 */
export const compileOptionProbe = (sql: string): string =>
  `SELECT * FROM ${nestBounded(normalizeOptionSql(sql))}`;

// ── The response reader ──────────────────────────────────────────────────────

const cell = (value: unknown): string => (value == null ? '' : String(value));

/**
 * Is `type` acceptable for an option value/label column?
 *
 * `String` and the wrappers that are transparent to VALUE handling —
 * `LowCardinality(String)`, `FixedString(N)` — all qualify: a low-cardinality
 * dimension column is the single most common real source of option values, and
 * rejecting it would reject the contract's own example. `Nullable(...)` does NOT:
 * the streaming transport renders a null cell as ClickHouse's literal `ᴺᵁᴸᴸ`
 * marker, which is meaningless as either a bound value or a label, so it is
 * better refused with its type named than silently offered as an option.
 */
export function isOptionColumnType(type?: string | null): boolean {
  const node = parseClickHouseType(String(type ?? '').trim());
  if (!node) return false;
  const mods = analyzeTypeModifiers(node);
  if (mods.nullable) return false;
  const base = mods.valueType.name;
  return base === 'String' || base === 'FixedString';
}

/**
 * Validate the response METADATA of a SINGLE variable's option query — the
 * variable tab's Run path (#465), where the columns describe that one query
 * rather than a compiled batch.
 *
 * This is where the contract's column rules are actually enforceable: exactly two
 * columns, both String. In the combined batch the same rules cannot be checked
 * from metadata at all, because `UNION ALL` reports one merged column list for
 * every branch (names from the first branch, types promoted to a supertype) — so
 * the batch relies on ClickHouse rejecting a branch whose arity disagrees, and
 * Run is how a user finds out precisely which variable is wrong and why.
 */
export function validateOptionColumns(
  columns: readonly { name: string; type: string }[],
): VariableOptionDiagnostic | null {
  if (columns.length !== 2) {
    return diagnostic('variable-option-column-count',
      `Option SQL must return exactly two columns (value, then label); this returns ${columns.length}.`);
  }
  const bad = columns.filter((column) => !isOptionColumnType(column.type));
  if (bad.length) {
    return diagnostic('variable-option-column-type',
      'Both option columns must be String; '
      + `this returns ${bad.map((column) => column.type).join(' and ')}.`);
  }
  return null;
}

/**
 * Turn one option-batch response into per-variable option lists.
 *
 * Read POSITIONALLY — `[name, value, label]` — which is the whole reason the
 * batch runs under the Compact streaming format. The name-keyed shape cannot
 * carry `SELECT environment, environment` (a duplicate output-column name
 * collapses on parse), and in a `UNION ALL` the column names come from the first
 * branch alone, so a later branch's value would silently be replaced by its
 * label. See `core/stream.ts`'s module doc.
 *
 * Rules, all from the contract:
 *   - rows are partitioned by EXACT, case-sensitive variable name;
 *   - a name the batch did not ask for is ignored rather than trusted;
 *   - duplicate values collapse to the FIRST row, keeping its label;
 *   - a blank value is dropped: UNSET is `''`, so an empty-valued option would be
 *     indistinguishable from "no selection" and could never be cleared;
 *   - option order follows response row order (a user's own `ORDER BY` is
 *     best-effort: `UNION ALL` over subqueries guarantees no ordering);
 *   - each variable is capped independently at `VARIABLE_OPTION_CAP`.
 *
 * A requested variable always gets an entry, empty when it returned nothing —
 * zero rows is a legal result, not a failure.
 */
export function readVariableOptionBatch(
  response: { columns?: readonly { name: string; type: string }[]; rows?: readonly unknown[][] },
  requested: readonly string[],
): VariableOptionResult {
  const byName = new Map<string, VariableOption[]>();
  const truncated = new Set<string>();
  for (const name of requested) byName.set(name, []);
  const columns = response.columns ?? [];
  // The ONLY structural check worth making: the compiler decides this shape, so
  // the sole way it can be wrong is that a branch's own arity was not 2 and
  // ClickHouse merged something else — a batch-level failure by definition.
  if (columns.length !== BATCH_COLUMN_COUNT) {
    return {
      byName,
      truncated,
      error: diagnostic('variable-option-batch-shape',
        'Every configured variable\'s option SQL must return exactly two columns '
        + '(value, then label). Open a variable from the Dashboards tree and run its '
        + 'SQL on its own to find the one that does not.'),
    };
  }
  const seen = new Map<string, Set<string>>();
  const rawCount = new Map<string, number>();
  for (const name of requested) { seen.set(name, new Set()); rawCount.set(name, 0); }
  for (const row of response.rows ?? []) {
    const name = cell(row[0]);
    const options = byName.get(name);
    // `undefined` for a name outside the requested set; `seen` and `rawCount` are
    // keyed by the same set, so they resolve whenever `options` does.
    if (options === undefined) continue;
    // Count RAW rows, before the blank/duplicate filters below. Each branch is
    // sent `LIMIT VARIABLE_OPTION_CAP + 1`, so receiving that many rows means the
    // SERVER cut the result off and there may be values we never saw. Deriving
    // the flag from the KEPT count instead would miss exactly that case whenever
    // duplicates or blanks collapsed the branch back under the cap (#461): a
    // query returning 1,001 rows of 500 distinct values is still an incomplete
    // list, and `applyOptions` must not prune a committed selection against one.
    const raw = rawCount.get(name)! + 1;
    rawCount.set(name, raw);
    if (raw > VARIABLE_OPTION_CAP) truncated.add(name);
    if (options.length >= VARIABLE_OPTION_CAP) continue;
    const value = cell(row[1]);
    if (value === '') continue;
    const values = seen.get(name)!;
    if (values.has(value)) continue;
    values.add(value);
    options.push({ value, label: cell(row[2]) });
  }
  return { byName, truncated, error: null };
}
