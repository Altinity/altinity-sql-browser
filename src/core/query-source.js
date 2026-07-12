// Pure derivation of the "source" metadata captured on a row-returning result
// so a detached Data view can re-run and title itself independently of the
// live editor/tab (#185).
//
// `expandDataPane` opens a result in a separate browser tab (or overlay) and
// makes it an interactive, re-runnable surface. To do that without reading the
// active editor at refresh time — which may have changed, or another tab may be
// active — the exact source is snapshotted at run time onto `result.source`:
//
//   { sql, tabId, rowLimit, title, description }
//
// `sql` is the authored single-statement template (optional-block markers
// intact; the param pipeline derives the execution view on every refresh).
// This module only normalizes the human-facing title/description; the SQL and
// ids are passed through verbatim. Pure — no DOM, no state.

import { inferQueryName } from './format.js';

/**
 * Build the immutable `source` metadata for a run's result.
 *
 * Title tiers (issue #185):
 *   - a saved query uses its saved `name`;
 *   - an unsaved query uses the tab name;
 *   - a blank or still-default (`Untitled`) name derives a stable fallback via
 *     `inferQueryName(sql)` ("Query · <table>").
 *
 * Description comes from the saved entry, trimmed; a missing description
 * normalizes to an empty string (unsaved queries have none).
 */
export function buildResultSource({ srcSql, tabId, rowLimit, tabName, savedEntry }) {
  const sql = String(srcSql);
  let title;
  let description;
  if (savedEntry) {
    title = savedEntry.name;
    description = (savedEntry.description || '').trim();
  } else {
    title = tabName && tabName !== 'Untitled' ? tabName : inferQueryName(sql);
    description = '';
  }
  if (!title || title === 'Untitled') title = inferQueryName(sql);
  return { sql, tabId, rowLimit, title, description };
}
