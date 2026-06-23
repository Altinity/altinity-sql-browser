// Encode/decode a shared query to/from a URL hash fragment, so a query (and its
// chart config) can be shared by link. UTF-8 safe (handles non-Latin1 via
// encodeURIComponent).
//
// Two on-the-wire shapes, both base64 of a UTF-8 string:
//  - legacy: the raw SQL string (links minted before charts shipped);
//  - tagged: JSON `{ __asb: 1, sql, chart }` when a chart config travels along.
// decodeShare accepts both and always returns `{ sql, chart }`.

const TAG = 1;

/** Encode SQL (+ optional chart payload `{ cfg, key }`) to a URL-hash string. */
export function encodeShare(sql, chart) {
  const payload = chart && chart.cfg ? JSON.stringify({ __asb: TAG, sql, chart }) : sql;
  return btoa(unescape(encodeURIComponent(payload)));
}

/**
 * Decode a URL hash (with or without a leading '#') to `{ sql, chart }`.
 * Unparseable input → `{ sql: '', chart: null }`; a legacy plain-SQL hash →
 * `{ sql, chart: null }`.
 */
export function decodeShare(hash) {
  if (!hash || hash.length < 2) return { sql: '', chart: null };
  let text;
  try {
    text = decodeURIComponent(escape(atob(hash.replace(/^#/, ''))));
  } catch {
    return { sql: '', chart: null };
  }
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.__asb === TAG && typeof obj.sql === 'string') {
      return { sql: obj.sql, chart: obj.chart && typeof obj.chart === 'object' ? obj.chart : null };
    }
  } catch {
    /* not a tagged envelope — fall through and treat as legacy raw SQL */
  }
  return { sql: text, chart: null };
}
