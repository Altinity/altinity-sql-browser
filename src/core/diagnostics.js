// The one shared diagnostic-object factory (#236). Every Dashboard/Filter-role
// module that reports problems builds the same `{severity, code, message,
// ...extra}` shape — the Filter SQL contract (filter-execution.js), the option
// bundle reader (filter-options.js), and the provider merge (dashboard-filters.js)
// — so they compose this one helper instead of each hand-rolling the literal.
// `extra` folds in the per-diagnostic context a caller carries (`helperName`,
// `sourceId`, `optionIndex`, or the Filter contract's fixed
// `path: ['dashboard', 'role']`).

/**
 * @param {string} severity 'error' | 'warning' | 'info'
 * @param {string} code stable machine code (e.g. 'filter-row-count')
 * @param {string} message human-readable message
 * @param {object} [extra] additional per-diagnostic fields merged onto the object
 * @returns {{severity: string, code: string, message: string}}
 */
export const diagnostic = (severity, code, message, extra = {}) => ({ severity, code, message, ...extra });
