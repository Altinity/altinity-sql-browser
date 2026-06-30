// Pure helpers for script-mode SELECT outcomes. A row-returning statement is
// run with FORMAT JSONCompact (one JSON object: { meta:[{name,type}], data:[[…]] })
// through the raw / wait_end_of_query path, so the whole body arrives as text and
// is parsed here once into a { columns, rows } shape — the same shape the result
// grid (renderTable) consumes. The script summary grid shows a one-line preview
// of the first row in column 2; clicking it opens the full table in a side pane.

/**
 * Parse a JSONCompact response body into `{ columns, rows, truncated }`, capping
 * `rows` at `cap` (default 100; the server also caps via max_result_rows, so this
 * is a display backstop). A blank body or one that isn't valid JSON yields an
 * empty result rather than throwing. Pure.
 */
export function parseSelectResult(rawText, cap = 100) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) return { columns: [], rows: [], truncated: false };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { columns: [], rows: [], truncated: false };
  }
  const columns = (json.meta || []).map((m) => ({ name: m.name, type: m.type }));
  const data = json.data || [];
  return { columns, rows: data.slice(0, cap), truncated: data.length > cap };
}

/**
 * A compact, comma-joined preview of the first row's values (the normal case is
 * one row / one number, e.g. a count). NULLs render empty, matching the result
 * grid. Truncated with an ellipsis past `max`. '' when there are no rows. Pure.
 */
export function firstRowPreview(rows, max = 160) {
  if (!rows || !rows.length) return '';
  const s = rows[0].map((v) => (v == null ? '' : String(v))).join(', ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
