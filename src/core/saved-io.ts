// Pure import/export/merge for saved-query documents. No DOM or globals.
// Envelope v1 is accepted and upgraded; v2 is the only emitted format. Every
// live/exported query uses { id, sql, specVersion, spec } and all extensibility
// stays inside the complete, losslessly-cloned Spec.

import {
  cloneJson, isPlainObject, queryContentKey,
  queryDescription, queryName, queryPanel, upgradeSavedQuery, upgradeV1Query,
  withQuerySpec,
} from './saved-query.js';
import type { QueryRoot } from './saved-query.js';
import {
  decodeLibraryJson, encodeLibraryDocument, throwingValue, validateSavedQueryDocument,
} from './library-codec.js';
import type { SpecDiagnostic } from '../editor/spec-editor.types.js';

// ── Injected Spec/Library validation seam ───────────────────────────────────
// The same shape state.ts's own `SpecValidationService` describes — kept as a
// local, structurally-equal interface (rather than importing state.ts, which
// itself imports this module) so the two stay independently typed but
// interchangeable at every call site.

export interface SavedIoValidationContext {
  sql?: string;
  query?: unknown;
}

export interface SavedIoValidationService {
  validate(spec: unknown, context?: SavedIoValidationContext): SpecDiagnostic[];
}

/** Build the canonical v2 export envelope. `nowISO` is injected for tests. */
export function buildExportDoc(queries: unknown, nowISO?: string): Record<string, unknown> {
  return throwingValue(encodeLibraryDocument(queries, { nowISO }));
}

function invalidSpecError(query: { id?: unknown }, index: number, diag: SpecDiagnostic): never {
  const identity = query.id ? `Query ${JSON.stringify(query.id)}` : `Query at index ${index}`;
  throw new Error(`${identity}: ${diag.message}.`);
}

/** Validate canonical/upgraded queries before any Library mutation. */
function validateLibraryEntries(
  entries: { raw: unknown; index: number }[], validationService: SavedIoValidationService | null,
): QueryRoot[] {
  return entries.map(({ raw, index }) => {
    // `as`: when `raw` already looks like a spec-bearing entry ('spec'/
    // 'specVersion' present) it is trusted to carry the same {id?, sql,
    // specVersion, spec} shape `upgradeV1Query`'s branch always returns —
    // only object-shape checked structurally above (the same ingress
    // convention as e.g. panel-cfg.ts's clonePanelCfg).
    const query = (isPlainObject(raw) && ('spec' in raw || 'specVersion' in raw)
      ? cloneJson(raw)
      : upgradeV1Query(raw)) as QueryRoot;
    // State compatibility callers historically mint a missing id after this
    // validation step. Portable Library decoding is strict and never uses this
    // placeholder path.
    const checked: QueryRoot = query.id ? query : { ...query, id: `__compat-${index}` };
    const structural = validateSavedQueryDocument(checked).find((item) => item.severity === 'error');
    if (structural) throw new Error(structural.message);
    if (validationService) {
      const feature = validationService.validate(query.spec, { sql: query.sql, query }).find((item) => item.severity === 'error');
      if (feature) invalidSpecError(query, index, feature);
    }
    return { id: query.id, sql: query.sql, specVersion: query.specVersion, spec: cloneJson(query.spec) };
  });
}

export function validateLibraryQueries(
  queries: readonly unknown[], validationService: SavedIoValidationService | null = null,
): QueryRoot[] {
  return validateLibraryEntries(queries.map((raw, index) => ({ raw, index })), validationService);
}

/** `parseImportDoc`'s result: the decoded envelope metadata plus the
 *  canonical, cloned, (optionally feature-validated) queries. */
export interface ParsedImportDoc {
  libraryVersion: unknown;
  format: unknown;
  exportedAt: unknown;
  schema: unknown;
  queries: QueryRoot[];
}

/**
 * Parse one Library JSON document. V1 keeps its historical forgiving item
 * behavior (non-object/non-string-SQL rows are skipped; missing names become
 * Untitled) and upgrades every supported entry. V2 is strict: any malformed
 * item rejects the whole file with its index, preventing partial data loss.
 */
export function parseImportDoc(
  text: unknown, validationService: SavedIoValidationService | null = null, options: Record<string, unknown> = {},
): ParsedImportDoc {
  const decoded = throwingValue(decodeLibraryJson(text, options));
  // `as`: `decodeLibraryJson` validates + migrates the document against the
  // canonical schema before this point, so `decoded.queries` is always an
  // array of canonical {id?, sql, specVersion, spec} entries — DecodedLibrary's
  // own `queries: unknown` stays deliberately loose (that module doesn't know
  // every consumer's shape needs).
  const queries = cloneJson(decoded.queries) as QueryRoot[];
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

/** `mergeSaved`'s result: the merged canonical list plus the three tallies. */
export interface MergeSavedResult {
  merged: (QueryRoot & { id: string })[];
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Merge canonical/upgradable queries without mutating either input. Content
 * identity is SQL + specVersion + the COMPLETE Spec (object key order ignored,
 * array order retained); id is identity, not content. A by-id update replaces
 * the complete incoming Spec, so extensions are never reconstructed.
 */
export function mergeSaved(
  existing: readonly unknown[], incoming: readonly unknown[], genId: () => string,
): MergeSavedResult {
  // `as`: every entry `mergeSaved` returns below is either an already-id'd
  // `existing` entry (the Library's own persisted identity) or one this loop
  // mints/keeps a real string id for (`current.id` or `freshId()`) —
  // `upgradeSavedQuery`/`withQuerySpec`'s own general QueryRoot contract
  // (`id: string | null | undefined`) doesn't encode that narrower,
  // mergeSaved-specific guarantee.
  const merged = existing.map(upgradeSavedQuery) as (QueryRoot & { id: string })[];
  const seen = new Set(merged.map(queryContentKey));
  const ids = new Set(merged.map((query) => query.id).filter((id): id is string => Boolean(id)));
  let added = 0, updated = 0, skipped = 0;

  const freshId = (): string => {
    let id: string;
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
      merged[index] = withQuerySpec({ ...inc, id: current.id }, inc.spec) as QueryRoot & { id: string };
      seen.add(queryContentKey(merged[index]));
      updated++;
      continue;
    }
    const key = queryContentKey(inc);
    if (seen.has(key)) { skipped++; continue; }
    const id = inc.id && !ids.has(inc.id) ? inc.id : freshId();
    const entry = withQuerySpec({ ...inc, id }, inc.spec) as QueryRoot & { id: string };
    ids.add(id);
    merged.push(entry);
    seen.add(key);
    added++;
  }
  return { merged, added, updated, skipped };
}

// ── One-way share/publish exports ───────────────────────────────────────────
// Markdown and SQL are lossy by design; JSON is the canonical round-trip form.

function textPanelContent(query: unknown): string | null {
  const panel = queryPanel(query);
  return panel && panel.cfg && panel.cfg.type === 'text' && typeof panel.cfg.content === 'string'
    ? panel.cfg.content
    : null;
}

export function buildMarkdownDoc(queries: readonly unknown[]): string {
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

export function buildSqlDoc(queries: readonly unknown[]): string {
  const safe = (value: string): string => value.replace(/\*\//g, '* /');
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
