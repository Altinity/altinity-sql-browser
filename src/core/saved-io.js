// Pure import/export/merge for saved-query documents. No DOM or globals.
// Envelope v1 is accepted and upgraded; v2 is the only emitted format. Every
// live/exported query uses { id, sql, specVersion, spec } and all extensibility
// stays inside the complete, losslessly-cloned Spec.

import {
  cloneJson, isPlainObject, queryContentKey,
  queryDescription, queryName, queryPanel, upgradeSavedQuery, upgradeV1Query,
  withQuerySpec,
} from './saved-query.js';
import {
  decodeLibraryJson, encodeLibraryDocument, throwingValue, validateSavedQueryDocument,
} from './library-codec.js';

/** Build the canonical v2 export envelope. `nowISO` is injected for tests. */
export function buildExportDoc(queries, nowISO) {
  return throwingValue(encodeLibraryDocument(queries, { nowISO }));
}

function invalidSpecError(query, index, diagnostic) {
  const identity = query.id ? `Query ${JSON.stringify(query.id)}` : `Query at index ${index}`;
  throw new Error(`${identity}: ${diagnostic.message}.`);
}

/** Validate canonical/upgraded queries before any Library mutation. */
function validateLibraryEntries(entries, validationService) {
  return entries.map(({ raw, index }) => {
    const query = isPlainObject(raw) && ('spec' in raw || 'specVersion' in raw)
      ? cloneJson(raw)
      : upgradeV1Query(raw);
    // State compatibility callers historically mint a missing id after this
    // validation step. Portable Library decoding is strict and never uses this
    // placeholder path.
    const checked = query.id ? query : { ...query, id: `__compat-${index}` };
    const structural = validateSavedQueryDocument(checked).find((item) => item.severity === 'error');
    if (structural) throw new Error(structural.message);
    if (validationService) {
      const feature = validationService.validate(query.spec, { sql: query.sql, query }).find((item) => item.severity === 'error');
      if (feature) invalidSpecError(query, index, feature);
    }
    return { id: query.id, sql: query.sql, specVersion: query.specVersion, spec: cloneJson(query.spec) };
  });
}

export function validateLibraryQueries(queries, validationService = null) {
  return validateLibraryEntries(queries.map((raw, index) => ({ raw, index })), validationService);
}

/**
 * Parse one Library JSON document. V1 keeps its historical forgiving item
 * behavior (non-object/non-string-SQL rows are skipped; missing names become
 * Untitled) and upgrades every supported entry. V2 is strict: any malformed
 * item rejects the whole file with its index, preventing partial data loss.
 */
export function parseImportDoc(text, validationService = null, options = {}) {
  const decoded = throwingValue(decodeLibraryJson(text, options));
  const queries = cloneJson(decoded.queries);
  if (validationService) {
    for (const [index, query] of queries.entries()) {
      const feature = validationService.validate(query.spec, { sql: query.sql, query }).find((item) => item.severity === 'error');
      if (feature) invalidSpecError(query, index, feature);
    }
  }
  return {
    ...decoded,
    queries,
  };
}

/**
 * Merge canonical/upgradable queries without mutating either input. Content
 * identity is SQL + specVersion + the COMPLETE Spec (object key order ignored,
 * array order retained); id is identity, not content. A by-id update replaces
 * the complete incoming Spec, so extensions are never reconstructed.
 */
export function mergeSaved(existing, incoming, genId) {
  const merged = existing.map(upgradeSavedQuery);
  const seen = new Set(merged.map(queryContentKey));
  const ids = new Set(merged.map((query) => query.id).filter(Boolean));
  let added = 0, updated = 0, skipped = 0;

  const freshId = () => {
    let id;
    do { id = genId(); } while (!id || ids.has(id));
    return id;
  };

  for (const rawIncoming of incoming) {
    const inc = upgradeSavedQuery(rawIncoming);
    const index = inc.id ? merged.findIndex((query) => query.id === inc.id) : -1;
    if (index >= 0) {
      const current = merged[index];
      if (queryContentKey(current) === queryContentKey(inc)) { skipped++; continue; }
      seen.delete(queryContentKey(current));
      merged[index] = withQuerySpec({ ...inc, id: current.id }, inc.spec);
      seen.add(queryContentKey(merged[index]));
      updated++;
      continue;
    }
    const key = queryContentKey(inc);
    if (seen.has(key)) { skipped++; continue; }
    const id = inc.id && !ids.has(inc.id) ? inc.id : freshId();
    const entry = withQuerySpec({ ...inc, id }, inc.spec);
    ids.add(id);
    merged.push(entry);
    seen.add(key);
    added++;
  }
  return { merged, added, updated, skipped };
}

// ── One-way share/publish exports ───────────────────────────────────────────
// Markdown and SQL are lossy by design; JSON is the canonical round-trip form.

const textPanelContent = (query) => {
  const panel = queryPanel(query);
  return panel && panel.cfg && panel.cfg.type === 'text' && typeof panel.cfg.content === 'string'
    ? panel.cfg.content
    : null;
};

export function buildMarkdownDoc(queries) {
  return queries.map((raw) => {
    const query = upgradeSavedQuery(raw);
    const name = queryName(query);
    const description = queryDescription(query);
    const blocks = ['### ' + name.replace(/\s+/g, ' ').trim()];
    if (description) blocks.push(description);
    const content = textPanelContent(query);
    if (content) blocks.push(content.trim());
    if (query.sql.trim() || content == null) {
      const fence = query.sql.includes('```') ? '````' : '```';
      blocks.push(fence + 'sql\n' + query.sql.trim() + '\n' + fence);
    }
    return blocks.join('\n\n');
  }).join('\n\n') + '\n';
}

export function buildSqlDoc(queries) {
  const safe = (value) => value.replace(/\*\//g, '* /');
  return queries.map(upgradeSavedQuery).filter((query) => query.sql.trim()).map((query) => {
    const description = queryDescription(query);
    const head = description ? queryName(query) + '\n' + description : queryName(query);
    const body = query.sql.trim().replace(/;+\s*$/, '');
    return '/* ' + safe(head) + ' */\n' + body + ';';
  }).join('\n\n') + '\n';
}

// Re-exported for compatibility while callers/tests migrate onto the dedicated
// model module in this same change. No legacy flat shape is returned.
export { upgradeSavedQuery as upgradeSavedEntry } from './saved-query.js';
