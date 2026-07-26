// Type-only contract for Dashboard variable inference (#447, ADR-0002 phase 0).
// Co-located with `dashboard-variables.ts`, which owns the behaviour.

/** One `{name:Type}` declaration found in one panel-owned query. */
export interface VariableDeclaration {
  /** The exact, case-sensitive variable name as written. */
  name: string;
  /** The declared ClickHouse type as written, with whitespace runs collapsed. */
  type: string;
  /** The Dashboard-local tile whose query declares it. */
  tileId: string;
  /** The saved query the tile owns. */
  queryId: string;
}

export type DashboardVariableStatus = 'active' | 'conflicted' | 'orphaned';

/** One row of a Dashboard's Variables subtree. */
export interface DashboardVariable {
  /** The exact, case-sensitive name — a variable's ONLY identity. */
  name: string;
  status: DashboardVariableStatus;
  /** Every distinct declared type, in declaration order, displayed as written.
   *  One entry when active; several when conflicted; the stored
   *  `lastKnownType` (or none) for an orphan. */
  types: string[];
  /** The one agreed type, or `null` when the declarations conflict or an orphan
   *  has no `lastKnownType`. */
  type: string | null;
  /** Every declaration of this name, in first-declaration order. Empty for an
   *  orphan. */
  declarations: VariableDeclaration[];
  /** Stored Dashboard-local option SQL, or `null` for direct input. */
  sql: string | null;
  /** Hover/accessible diagnostic for a conflicted or orphaned variable; `null`
   *  when the variable is fine. */
  diagnostic: string | null;
}

export interface InferDashboardVariablesInput {
  /** The Dashboard's tiles, in tile order. */
  tiles: readonly { id: string; queryId: string }[];
  /** The workspace's saved queries; only the ones tiles reference are read. */
  queries: readonly { id: string; sql?: string }[];
  /** `dashboard.variableConfigs`. */
  variableConfigs?: Record<string, { sql: string; lastKnownType?: string }> | undefined;
  /** Tile id -> the label to name that panel by in a conflict diagnostic.
   *  Falls back to the tile id. */
  tileLabels?: Readonly<Record<string, string>>;
}
