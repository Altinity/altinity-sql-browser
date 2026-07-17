// Fallback keyword / function reference data for the SQL editor (#182). These
// are completion/reference *fallback* sets, not lexical rules: the editor
// prefers server-provided `system.keywords` / `system.functions` (loaded per
// connection, see net/ch-client.js) and falls back to these only offline / on
// an older server / when access is denied (assembleReferenceData in
// completions.js). The uppercased keyword set also preserves the implicit-alias
// stop behavior in from-scope.js now that the lexer no longer classifies
// keyword tokens.
//
// Relocated verbatim from the deleted highlighter tokenizer (sql-highlight.js).

export const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'IS', 'NULL',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'ON', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'UNION', 'ALL', 'DISTINCT', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'WITH', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'VIEW', 'INDEX', 'DROP', 'ALTER', 'SHOW', 'DESCRIBE', 'DESC', 'ASC',
  'EXPLAIN', 'USE', 'SETTINGS', 'FORMAT', 'ARRAY', 'TUPLE', 'MAP', 'PREWHERE', 'FINAL',
  'SAMPLE', 'TOP', 'ANTI', 'SEMI', 'ANY', 'ASOF', 'GLOBAL', 'LOCAL', 'TRUE', 'FALSE',
]);

export const SQL_FUNCS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'round', 'floor', 'ceil', 'abs', 'length',
  'lower', 'upper', 'substring', 'concat', 'toString', 'toDate', 'toDateTime',
  'toStartOfMonth', 'toStartOfWeek', 'toStartOfDay', 'toStartOfHour', 'now',
  'today', 'yesterday', 'formatDateTime', 'if', 'multiIf', 'coalesce', 'isNull',
  'isNotNull', 'quantile', 'quantiles', 'uniq', 'uniqExact', 'any', 'anyLast',
  'groupArray', 'groupUniqArray', 'arrayJoin', 'arrayMap', 'arrayFilter',
  'splitByChar', 'toUInt32', 'toInt64', 'toFloat64', 'toUInt8', 'greatest', 'least',
  'version', 'currentUser', 'uptime', 'formatReadableSize',
]);
