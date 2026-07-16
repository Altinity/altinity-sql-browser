// The one shared diagnostic-object factory (#236). Every Dashboard/Filter-role
// module that reports problems builds the same `{severity, code, message,
// ...extra}` shape — the Filter SQL contract (filter-execution.js), the option
// bundle reader (filter-options.js), and the provider merge (dashboard-filters.js)
// — so they compose this one helper instead of each hand-rolling the literal.
// `extra` folds in the per-diagnostic context a caller carries (`helperName`,
// `sourceId`, `optionIndex`, or the Filter contract's fixed
// `path: ['dashboard', 'role']`).

/** The three severities every diagnostic carries. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** The shared `{severity, code, message, ...extra}` shape — `extra`'s fields
 *  vary per caller (`helperName`, `sourceId`, `optionIndex`, the Filter
 *  contract's fixed `path`, …), so they fold onto the object via an open
 *  index signature rather than being named here. */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  [key: string]: unknown;
}

/**
 * `severity` — 'error' | 'warning' | 'info'.
 * `code` — stable machine code (e.g. 'filter-row-count').
 * `message` — human-readable message.
 * `extra` — additional per-diagnostic fields merged onto the object.
 */
export const diagnostic = (
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Diagnostic => ({ severity, code, message, ...extra });
