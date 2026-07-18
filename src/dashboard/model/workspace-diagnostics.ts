// Workspace/Dashboard/bundle diagnostic contract and the one deterministic
// diagnostic sorter (#280 "Diagnostic ordering"): severity (error, warning,
// information), then numeric-aware path segment comparison, then diagnostic
// code, then resource ID, then message. Every Phase-1 call site returns
// diagnostics through `sortDiagnostics` so concurrent validation can never
// make the order nondeterministic. Pure.

/** Diagnostic severity in canonical order of importance. */
export type WorkspaceSeverity = 'error' | 'warning' | 'information';

/** One workspace/Dashboard/bundle diagnostic with a stable application code
 *  and an exact document path. `resource` carries the owning resource ID
 *  (query, Dashboard, tile, or filter ID) where one exists. The index
 *  signature admits the schema-layer diagnostics (`SchemaDiagnostic`, which
 *  adds `keyword`/`schemaId`) without a copy. */
export interface WorkspaceDiagnostic {
  path: (string | number)[];
  severity: WorkspaceSeverity;
  code: string;
  message: string;
  resource?: string;
  [key: string]: unknown;
}

const SEVERITY_RANK: Record<WorkspaceSeverity, number> = { error: 0, warning: 1, information: 2 };

/** Build one error diagnostic (the common case in Phase 1). */
export function diagnostic(
  path: (string | number)[], code: string, message: string, resource?: string,
): WorkspaceDiagnostic {
  return { path, severity: 'error', code, message, ...(resource === undefined ? {} : { resource }) };
}

// Numeric-aware segment comparison: numeric segments (array indexes — number
// typed, or all-digit strings from foreign tooling) compare numerically and
// sort before string segments; string segments compare by code unit so the
// order is locale-independent.
const numericValue = (segment: string | number): number | null => {
  if (typeof segment === 'number') return segment;
  return /^\d+$/.test(segment) ? Number(segment) : null;
};

export function comparePathSegments(a: string | number, b: string | number): number {
  const an = numericValue(a);
  const bn = numericValue(b);
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function comparePaths(a: readonly (string | number)[], b: readonly (string | number)[]): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    const order = comparePathSegments(a[index], b[index]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareDiagnostics(a: WorkspaceDiagnostic, b: WorkspaceDiagnostic): number {
  return (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || comparePaths(a.path, b.path)
    || compareStrings(a.code, b.code)
    || compareStrings(a.resource ?? '', b.resource ?? '')
    || compareStrings(a.message, b.message);
}

/** Return a new deterministically sorted copy; the input is never mutated. */
export function sortDiagnostics<T extends WorkspaceDiagnostic>(diagnostics: readonly T[]): T[] {
  return [...diagnostics].sort(compareDiagnostics);
}
