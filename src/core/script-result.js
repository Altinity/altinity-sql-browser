// Pure helpers for script-mode SELECT outcomes. A row-returning statement is
// run with FORMAT JSONCompact (one JSON object: { meta:[{name,type}], data:[[…]] })
// through the raw / wait_end_of_query path, so the whole body arrives as text and
// is parsed here once into a { columns, rows } shape — the same shape the result
// grid (renderTable) consumes. The script summary grid shows a one-line preview
// of the first row in column 2; clicking it opens the full table in a side pane.

// The display cap for a script-mode SELECT. The runner asks the server for
// SELECT_ROW_CAP + 1 rows (so it can tell a result was truncated — at exactly
// the cap it can't) and shows at most SELECT_ROW_CAP.
export const SELECT_ROW_CAP = 100;

/**
 * Parse a JSONCompact response body into `{ columns, rows, truncated }`, capping
 * `rows` at `cap` (default SELECT_ROW_CAP). `truncated` is true when more than
 * `cap` rows came back (the runner over-fetches by one to detect this). A blank
 * body or one that isn't valid JSON yields an empty result rather than throwing.
 * Pure.
 */
export function parseSelectResult(rawText, cap = SELECT_ROW_CAP) {
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
