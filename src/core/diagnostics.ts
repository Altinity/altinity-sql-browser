// The one shared diagnostic-object factory (#236). Every Dashboard module that
// reports problems builds the same `{severity, code, message, ...extra}` shape,
// so they compose this one helper instead of each hand-rolling the literal.
// `extra` folds in the per-diagnostic context a caller carries (e.g. a `path`,
// a `tileId`, or a source identifier). (#447 removed the three original
// callers — the Filter SQL contract, the option-bundle reader, and the curated
// provider merge — along with the option-provider model itself.)

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
