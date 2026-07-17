// Pure helpers for script-mode SELECT outcomes. A row-returning statement is
// run with FORMAT JSONCompact (one JSON object: { meta:[{name,type}], data:[[…]] })
// through the raw / wait_end_of_query path, so the whole body arrives as text and
// is parsed here once into a { columns, rows } shape — the same shape the result
// grid (renderTable) consumes. The script summary grid shows a one-line preview
// of the first row in column 2; clicking it opens the full table in a side pane.

import { truncate } from './format.js';
import type { ResultSort } from './sort.js';

// The display cap for a script-mode SELECT. The runner asks the server for
// SELECT_ROW_CAP + 1 rows (so it can tell a result was truncated — at exactly
// the cap it can't) and shows at most SELECT_ROW_CAP.
export const SELECT_ROW_CAP = 100;

/** One `meta` entry of a FORMAT JSONCompact response body. */
interface JsonCompactMeta {
  name: string;
  type: string;
  [k: string]: unknown;
}

// The `{meta, data}` shape a FORMAT JSONCompact response body parses into —
// narrowed to the two fields this parser reads; a missing/non-array meta or
// data degrades to empty via the `|| []` fallbacks below, same as the
// original untyped behavior.
interface JsonCompactBody {
  meta?: JsonCompactMeta[];
  data?: unknown[][];
  [k: string]: unknown;
}

/** `parseSelectResult`'s return shape — the same `{columns, rows}` shape the
 *  result grid (renderTable) consumes, plus a truncation flag. */
export interface SelectResult {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  truncated: boolean;
}

/**
 * Parse a JSONCompact response body into `{ columns, rows, truncated }`, capping
 * `rows` at `cap` (default SELECT_ROW_CAP). `truncated` is true when more than
 * `cap` rows came back (the runner over-fetches by one to detect this). A blank
 * body or one that isn't valid JSON yields an empty result rather than throwing.
 * Pure.
 */
export function parseSelectResult(rawText: unknown, cap: number = SELECT_ROW_CAP): SelectResult {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) return { columns: [], rows: [], truncated: false };
  let json: JsonCompactBody;
  try {
    // Ingress: a raw HTTP response body is arbitrary text — only object-shape
    // proven here (the try/catch above); `meta`/`data` are read defensively
    // (`|| []`) exactly like the pre-conversion behavior.
    json = JSON.parse(text) as JsonCompactBody;
  } catch {
    return { columns: [], rows: [], truncated: false };
  }
  const columns = (json.meta || []).map((m) => ({ name: m.name, type: m.type }));
  const data = json.data || [];
  return { columns, rows: data.slice(0, cap), truncated: data.length > cap };
}

/** One statement's outcome in a multiquery script run (#83) — one entry of
 *  `ScriptResult.script`. `sql`/`ms` ride on every status; the rest is
 *  per-status (a 'rows' entry is the only one carrying real data). */
export type ScriptEntry = { sql?: string; ms?: number } & (
  | { status: 'ok' }
  | { status: 'error'; error?: string }
  | {
      status: 'rows';
      columns: { name: string; type: string }[];
      rows: unknown[][];
      truncated?: boolean;
      preview?: string;
      /** Local sort/width state, lazily attached by openRowsViewer — persists
       *  for the life of that statement's open rows pane. */
      viewerSort?: ResultSort;
      viewerWidths?: Record<string, number>;
    }
);

/**
 * A compact, comma-joined preview of the first row's values (the normal case is
 * one row / one number, e.g. a count). NULLs render empty, matching the result
 * grid. Truncated with an ellipsis past `max`. '' when there are no rows. Pure.
 */
export function firstRowPreview(rows: unknown[][] | null | undefined, max: number = 160): string {
  if (!rows || !rows.length) return '';
  return truncate(rows[0].map((v) => (v == null ? '' : String(v))).join(', '), max);
}
