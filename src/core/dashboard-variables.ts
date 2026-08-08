// Dashboard VARIABLE inference (#447). A Dashboard's variables are not stored —
// they are derived from the `{name:Type}` placeholders in the queries its panel
// tiles own, aggregated by EXACT, case-sensitive name. `country` and `Country`
// are two variables; there is no fuzzy or case-insensitive matching anywhere.
//
// This replaces the curated-filter model, where a variable was a persisted
// object with its own id, label, option-source query reference and explicit
// target list. The only thing still persisted is `dashboard.variableConfigs` —
// optional option SQL, keyed by variable name — so adding or removing a panel
// query automatically changes the effective variable list and creating a
// variable is never a separate user action.
//
// Three states come out of that aggregation:
//
//   active      one declaration, or several that all agree on a type
//   conflicted  the same name declared with two or more DIFFERENT types
//   orphaned    stored option SQL whose name no panel query declares any more
//
// Type agreement is decided by `canonicalType` (the shared declaration-identity
// comparison), so `Nullable( String )` and `Nullable(String)` agree while
// `UInt64` and `String` do not. Every distinct type is kept for display, because
// a conflicted row has to SHOW what disagrees.
//
// Pure — no DOM, no persistence, no signals, no injected services.

import { scanParamDeclarations } from './param-scan.js';
import { analysisView } from './param-pipeline.js';
// Issue #630 Phase 5 — `canonicalType` now comes directly from `@altinity/clickhouse-http`.
import { canonicalType } from '@altinity/clickhouse-http';
import type {
  DashboardVariable, DashboardVariableStatus, InferDashboardVariablesInput,
  VariableDeclaration,
} from './dashboard-variables.types.js';

export type {
  DashboardVariable, DashboardVariableStatus, InferDashboardVariablesInput,
  VariableDeclaration,
} from './dashboard-variables.types.js';

/** Collapse declaration whitespace so a type reads the way it was written but
 *  compares and displays consistently (`Nullable( String )` -> `Nullable(String)`
 *  is `canonicalType`'s job; this only tidies runs of spaces and newlines). */
const tidyType = (type: string): string => type.replace(/\s+/g, ' ').trim();

const quoted = (name: string): string => `“${name}”`;

/** The conflict hover diagnostic: every conflicting usage, one per line, labelled
 *  by the panel that declares it and showing the placeholder verbatim so the
 *  reader can search for it. */
function conflictDiagnostic(
  name: string, declarations: readonly VariableDeclaration[],
  label: (declaration: VariableDeclaration) => string,
): string {
  const lines = declarations.map((declaration) =>
    `${label(declaration)}: {${name}:${declaration.type}}`);
  return `Variable ${quoted(name)} has incompatible types:\n\n${lines.join('\n')}`;
}

const orphanDiagnostic = (name: string): string =>
  `Variable ${quoted(name)} is not referenced by any Dashboard panel.\n`
  + 'Its option SQL is preserved but will not be executed.';

/**
 * Infer one Dashboard's variables from its panel-owned queries plus its stored
 * option SQL.
 *
 * Ordering is deterministic and is the order every consumer follows — the
 * Variables tree, and the compiled option-query batch: inferred variables in
 * FIRST-DECLARATION order (tiles in tile order, placeholders in appearance
 * order within each query), then orphaned configurations sorted by name. First
 * declaration rather than alphabetical because it keeps a Dashboard's controls in
 * the order its panels actually read them, and it stays stable while a user edits
 * a query's WHERE clause.
 *
 * A tile whose `queryId` resolves to nothing contributes no declarations; a
 * dangling tile reference is a separate cross-resource diagnostic and is not
 * this function's to report.
 */
export function inferDashboardVariables(
  input: InferDashboardVariablesInput,
): DashboardVariable[] {
  const sqlByQueryId = new Map<string, string>();
  for (const query of input.queries) {
    if (!sqlByQueryId.has(query.id)) sqlByQueryId.set(query.id, typeof query.sql === 'string' ? query.sql : '');
  }

  // Insertion order IS first-declaration order: a Map preserves it, and the
  // walk below is tile order then appearance order.
  const byName = new Map<string, VariableDeclaration[]>();
  for (const tile of input.tiles) {
    const sql = sqlByQueryId.get(tile.queryId);
    if (sql === undefined) continue;
    // Scan the ANALYSIS view, not the raw SQL. A `{name:Type}` declared only
    // inside a `/*[ … ]*/` optional block (#165) sits inside what a raw lexical
    // scan treats as a block comment, so scanning the raw text would infer no
    // variable for it — and the block could then never be activated from the
    // Dashboard, because nothing would render a control. `analysisView` is the
    // same all-blocks-active materialization `analyzeParameterizedSources` runs
    // before recording its own per-field declarations, so the variable set here
    // and the control set there agree by construction.
    for (const occurrence of scanParamDeclarations(analysisView(sql))) {
      const declaration: VariableDeclaration = {
        name: occurrence.name,
        type: tidyType(occurrence.type),
        tileId: tile.id,
        queryId: tile.queryId,
      };
      const existing = byName.get(occurrence.name);
      if (existing) existing.push(declaration);
      else byName.set(occurrence.name, [declaration]);
    }
  }

  const configs = input.variableConfigs ?? {};
  const label = (declaration: VariableDeclaration): string =>
    input.tileLabels?.[declaration.tileId] ?? declaration.tileId;

  const out: DashboardVariable[] = [];
  for (const [name, declarations] of byName) {
    // Distinct types in declaration order, compared canonically but DISPLAYED as
    // written — the reader has to recognize them in their own SQL.
    const types: string[] = [];
    const seen = new Set<string>();
    for (const declaration of declarations) {
      const key = canonicalType(declaration.type);
      if (seen.has(key)) continue;
      seen.add(key);
      types.push(declaration.type);
    }
    const conflicted = types.length > 1;
    const config = Object.hasOwn(configs, name) ? configs[name] : undefined;
    out.push({
      name,
      status: conflicted ? 'conflicted' : 'active',
      types,
      type: conflicted ? null : types[0],
      declarations,
      sql: config === undefined ? null : config.sql,
      diagnostic: conflicted ? conflictDiagnostic(name, declarations, label) : null,
    });
  }

  const orphanNames = Object.keys(configs).filter((name) => !byName.has(name)).sort();
  for (const name of orphanNames) {
    const config = configs[name];
    const lastKnownType = config.lastKnownType;
    out.push({
      name,
      status: 'orphaned',
      // `lastKnownType` is display-only and may be absent, in which case the row
      // shows a name with no type rather than inventing one.
      types: lastKnownType === undefined ? [] : [lastKnownType],
      type: lastKnownType ?? null,
      declarations: [],
      sql: config.sql,
      diagnostic: orphanDiagnostic(name),
    });
  }
  return out;
}

/** The variables a Dashboard control surface may render and bind: inferred and
 *  type-consistent. A conflicted variable renders a diagnostic row instead of a
 *  working control, and an orphan is hidden from the controls entirely. */
export const bindableVariables = (variables: readonly DashboardVariable[]): DashboardVariable[] =>
  variables.filter((variable) => variable.status === 'active');

/** The tile ids a variable binds to: every panel on this Dashboard whose query
 *  declares that exact name. There is no persisted target list — this IS the
 *  binding. */
export const variableTileIds = (variable: DashboardVariable): string[] =>
  [...new Set(variable.declarations.map((declaration) => declaration.tileId))];

/**
 * The option SQL that should be stored for a variable, or `null` to remove the
 * configuration entirely.
 *
 * Saving blank SQL is how a user returns an ACTIVE variable to direct input, so
 * whitespace-only input erases the entry rather than storing an empty string
 * that would later look like a configured-but-broken option query.
 */
export const normalizeVariableSql = (sql: string): string | null =>
  (sql.trim() === '' ? null : sql);
