// Encode/decode a shared query to/from a URL hash fragment, so a query (and its
// panel config) can be shared by link. UTF-8 safe (handles non-Latin1 via
// encodeURIComponent).
//
// Three on-the-wire shapes, all base64 of a UTF-8 string:
//  - legacy raw: the SQL string (links minted before charts shipped);
//  - legacy tagged: JSON `{ __asb: 1, sql, chart }` (pre-#166 chart links);
//  - tagged: JSON `{ __asb: 1, sql, panel, chart? }` — `chart` is the
//    dual-write mirror for chart-family panels, so a link opened by an older
//    build still shows its chart (that build reads `chart`, drops `panel`).
// decodeShare accepts all three and always returns `{ sql, panel }` (the
// legacy chart payload is upgraded via upgradeSavedEntry).

import { upgradeSavedEntry, withChartMirror } from './saved-io.js';

const TAG = 1;

/** Encode SQL (+ optional panel payload `{ cfg, key? }`) to a URL-hash string. */
export function encodeShare(sql, panel) {
  const payload = panel && panel.cfg
    ? JSON.stringify(withChartMirror({ __asb: TAG, sql, panel }))
    : sql;
  return btoa(unescape(encodeURIComponent(payload)));
}

/**
 * Decode a URL hash (with or without a leading '#') to `{ sql, panel }`.
 * Unparseable input → `{ sql: '', panel: null }`; a legacy plain-SQL hash →
 * `{ sql, panel: null }`; a legacy `{ sql, chart }` envelope upgrades to a
 * chart-family panel.
 */
export function decodeShare(hash) {
  if (!hash || hash.length < 2) return { sql: '', panel: null };
  let text;
  try {
    text = decodeURIComponent(escape(atob(hash.replace(/^#/, ''))));
  } catch {
    return { sql: '', panel: null };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.__asb === TAG && typeof obj.sql === 'string') {
      const up = upgradeSavedEntry({
        sql: obj.sql,
        panel: obj.panel && typeof obj.panel === 'object' ? obj.panel : undefined,
        chart: obj.chart && typeof obj.chart === 'object' ? obj.chart : undefined,
      });
      return { sql: up.sql, panel: up.panel && up.panel.cfg ? up.panel : null };
    }
  } catch {
    /* not a tagged envelope — fall through and treat as legacy raw SQL */
  }
  return { sql: text, panel: null };
}
