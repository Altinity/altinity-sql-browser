// Pure helpers for the EXPLAIN result views (Explain / Indexes / Projections /
// Pipeline / Estimate). No DOM, no globals.
//
// The data pane offers five views of an EXPLAIN. The **Explain** view runs the
// user's statement *verbatim* (so arbitrary parameters are honored); the other
// four derive a canonical query from the inner statement and render it our way.
// On a run we auto-select a rich view only when the typed statement is *exactly*
// that canonical form (see `detectExplainView`); anything else falls back to the
// verbatim Explain view.

/**
 * The five EXPLAIN views, in tab order. `kind` picks the renderer
 * (`text` → monospace, `table` → tabular, `graph` → SVG pipeline graph);
 * `chFormat` is the ClickHouse output format to run the view in
 * (`TabSeparatedRaw` → clean raw text/DOT; `Table` → structured streaming rows).
 */
export const EXPLAIN_VIEWS = [
  { id: 'explain', label: 'Explain', kind: 'text', chFormat: 'TabSeparatedRaw' },
  { id: 'indexes', label: 'Indexes', kind: 'text', chFormat: 'TabSeparatedRaw' },
  { id: 'projections', label: 'Projections', kind: 'text', chFormat: 'TabSeparatedRaw' },
  { id: 'pipeline', label: 'Pipeline', kind: 'graph', chFormat: 'TabSeparatedRaw' },
  { id: 'estimate', label: 'Estimate', kind: 'table', chFormat: 'Table' },
];

/**
 * Parse an EXPLAIN statement into `{ kind, settings, inner }`, or `null` when
 * `sql` is not an EXPLAIN. `kind` is the upper-cased form keyword (default
 * `PLAN`; `EXPLAIN` alone is a synonym for `EXPLAIN PLAN`), `settings` is the
 * `name = value` map that precedes the inner statement (values lower-cased keys,
 * string values unquoted), and `inner` is the wrapped statement. Pure.
 */
export function parseExplain(sql) {
  const s = String(sql || '');
  const m = /^\s*EXPLAIN\b/i.exec(s);
  if (!m) return null;
  let rest = s.slice(m[0].length);
  // Optional form keyword (multi-word forms first so they win the alternation).
  let kind = 'PLAN';
  const km = /^\s*(QUERY\s+TREE|CURRENT\s+TRANSACTION|TABLE\s+OVERRIDE|PLAN|PIPELINE|ESTIMATE|AST|SYNTAX)\b/i.exec(rest);
  if (km) {
    kind = km[1].toUpperCase().replace(/\s+/g, ' ');
    rest = rest.slice(km[0].length);
  }
  // Optional `name = value` settings (comma- or space-separated). A statement
  // keyword (SELECT/WITH/…) has no `=` after it, so the loop stops at the inner
  // query on its own.
  const settings = {};
  const setRe = /^\s*,?\s*([a-z_][a-z0-9_]*)\s*=\s*([0-9]+|'[^']*'|[a-z_][a-z0-9_]*)/i;
  let sm;
  while ((sm = setRe.exec(rest))) {
    settings[sm[1].toLowerCase()] = sm[2].replace(/^'|'$/g, '');
    rest = rest.slice(sm[0].length);
  }
  return { kind, settings, inner: rest.trim() };
}

/**
 * The rich view a parsed EXPLAIN *exactly* matches, or `null` (= use the
 * verbatim Explain view). Only a single defining setting/kind qualifies, so
 * complex parameter combinations stay on the verbatim Explain tab. Pure.
 */
export function detectExplainView(parsed) {
  if (!parsed) return null;
  const set = parsed.settings || {};
  const keys = Object.keys(set);
  const onlyOne = (k) => keys.length === 1 && set[k] === '1';
  if (parsed.kind === 'PLAN' && onlyOne('indexes')) return 'indexes';
  if (parsed.kind === 'PLAN' && onlyOne('projections')) return 'projections';
  if (parsed.kind === 'PIPELINE' && set.graph === '1') {
    // graph=1 (our pipeline mode), with an optional compact tweak — nothing else.
    const extra = keys.filter((k) => k !== 'graph' && k !== 'compact');
    if (!extra.length) return 'pipeline';
  }
  if (parsed.kind === 'ESTIMATE' && keys.length === 0) return 'estimate';
  return null;
}

/**
 * Build the derived query for a rich view from the inner statement. The
 * `explain` view does not derive (the caller runs the statement verbatim);
 * unknown ids fall back to a plain `EXPLAIN`. Pure.
 */
export function buildExplainQuery(inner, viewId) {
  const q = String(inner || '');
  switch (viewId) {
    case 'indexes': return 'EXPLAIN indexes = 1 ' + q;
    case 'projections': return 'EXPLAIN projections = 1 ' + q;
    case 'pipeline': return 'EXPLAIN PIPELINE graph = 1 ' + q;
    case 'estimate': return 'EXPLAIN ESTIMATE ' + q;
    default: return 'EXPLAIN ' + q;
  }
}
