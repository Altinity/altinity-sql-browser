// Lossless saved-query sharing through a URL hash. The v2 wire shape is a
// documented identity-free subset of the canonical query:
//   { __asb: 2, query: { sql, specVersion, spec } }
// `id` is intentionally omitted so opening/saving a link cannot collide with
// Library identity. Raw SQL and legacy tagged {sql,chart/panel} links remain
// accepted and are upgraded into the same complete Spec shape.

import {
  SPEC_VERSION, cloneJson, cloneV2Query, isPlainObject, upgradeV1Query, withQuerySpec,
} from './saved-query.js';

const TAG = 2;
const LEGACY_TAG = 1;

const sharedQuery = (query) => ({
  sql: query.sql,
  specVersion: query.specVersion,
  spec: cloneJson(query.spec),
});

const emptyShared = () => ({ sql: '', specVersion: SPEC_VERSION, spec: { name: 'Shared query', favorite: false } });

/** Encode a canonical query (or a legacy sql/panel call for compatibility). */
export function encodeShare(queryOrSql, legacyPanel) {
  const query = typeof queryOrSql === 'string'
    ? upgradeV1Query({ name: 'Shared query', sql: queryOrSql, panel: legacyPanel })
    : cloneV2Query(queryOrSql);
  const payload = JSON.stringify({ __asb: TAG, query: sharedQuery(query) });
  return btoa(unescape(encodeURIComponent(payload)));
}

function decodeTagged(obj) {
  if (obj && obj.__asb === TAG && isPlainObject(obj.query)) {
    const query = obj.query;
    if (typeof query.sql !== 'string' || query.specVersion !== SPEC_VERSION || !isPlainObject(query.spec)) return null;
    return sharedQuery(withQuerySpec(query, query.spec));
  }
  if (obj && obj.__asb === LEGACY_TAG && typeof obj.sql === 'string') {
    return sharedQuery(upgradeV1Query({
      name: 'Shared query', sql: obj.sql,
      panel: isPlainObject(obj.panel) ? obj.panel : undefined,
      chart: isPlainObject(obj.chart) ? obj.chart : undefined,
    }));
  }
  return null;
}

/** Decode a hash to the canonical identity-free subset. Invalid input is empty. */
export function decodeShare(hash) {
  if (!hash || hash.length < 2) return emptyShared();
  let text;
  try {
    text = decodeURIComponent(escape(atob(hash.replace(/^#/, ''))));
  } catch {
    return emptyShared();
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return sharedQuery(upgradeV1Query({ name: 'Shared query', sql: text }));
  }
  if (parsed && (parsed.__asb === TAG || parsed.__asb === LEGACY_TAG)) {
    try { return decodeTagged(parsed) || emptyShared(); } catch { return emptyShared(); }
  }
  return sharedQuery(upgradeV1Query({ name: 'Shared query', sql: text }));
}
