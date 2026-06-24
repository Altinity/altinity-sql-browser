// A tiny, dependency-free SQL tokenizer for syntax highlighting. `tokenize`
// is pure (string -> [type, text][]); the UI layer turns tokens into spans.

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

/**
 * Tokenize SQL into [type, text] pairs. Types: comment, string, ident,
 * number, keyword, func, op, ws, other. The `ident` type covers backtick /
 * double-quoted identifiers and bare words that are neither keyword nor func.
 *
 * The optional second arg lets a caller override the keyword/function sets
 * (#25) — e.g. the server's `system.keywords` / `system.functions` — so
 * highlighting is version-correct. It is backward-compatible: existing callers
 * pass nothing and get the built-in sets. `keywords` is matched
 * case-insensitively (uppercased lookup); `funcs` is matched as-is.
 */
export function tokenize(sql, { keywords = SQL_KEYWORDS, funcs = SQL_FUNCS } = {}) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') j++;
      out.push(['comment', sql.slice(i, j)]);
      i = j;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let j = i + 2;
      while (j < n - 1 && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      out.push(['comment', sql.slice(i, j)]);
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== c) {
        if (sql[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      out.push([c === '`' ? 'ident' : 'string', sql.slice(i, j)]);
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < n && /[0-9.eE+\-]/.test(sql[j])) {
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1])) break;
        j++;
      }
      out.push(['number', sql.slice(i, j)]);
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      let type = 'ident';
      if (keywords.has(upper)) type = 'keyword';
      else if (funcs.has(word)) type = 'func';
      out.push([type, word]);
      i = j;
      continue;
    }
    if (/[=<>!+\-*/%(),.;]/.test(c)) {
      out.push(['op', c]);
      i++;
      continue;
    }
    let j = i;
    while (j < n && /\s/.test(sql[j])) j++;
    if (j > i) {
      out.push(['ws', sql.slice(i, j)]);
      i = j;
      continue;
    }
    out.push(['other', c]);
    i++;
  }
  return out;
}

// A same-length copy of `sql` with every string-literal, comment, and
// backtick-quoted-identifier character replaced by NUL ('\0'). Bracket matching
// (#24), signature help (#27), and auto-close decisions run on this so that
// brackets/quotes/commas inside literals don't pair, count as arguments, or
// trigger auto-close. NUL is none of `(),;\n`, so the raw-char scanners skip it.
// Offsets are preserved (same length), so indices map back to the real text.
export function maskFromTokens(tokens) {
  let out = '';
  for (const [t, v] of tokens) {
    const literal = t === 'string' || t === 'comment' || (t === 'ident' && v[0] === '`');
    out += literal ? '\0'.repeat(v.length) : v;
  }
  return out;
}

// Convenience wrapper that tokenizes then masks. Callers on the keystroke path
// that already tokenized for highlighting should reuse maskFromTokens with that
// token list instead, to avoid a second pass (#5 review). String/comment
// classification is independent of the keyword/func sets, so a token list built
// with server keyword overrides yields the same mask.
export function maskLiterals(sql) {
  return maskFromTokens(tokenize(sql));
}
