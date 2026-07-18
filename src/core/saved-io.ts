// Pure Library-document import + one-way share/publish exports. No DOM or
// globals. Envelope v1 is accepted and upgraded; v2 is the only import format
// otherwise recognized (#287 W5 retired the JSON-Library WRITE path —
// `parseImportDoc` stays the read/migration path `normalizeLegacyLibraryToBundle`
// builds on via `decodeLibraryJson` directly, and the example-file regression
// suite (`tests/unit/spec-examples.test.js`) exercises it independently). Every
// live/imported query uses { id, sql, specVersion, spec } and all extensibility
// stays inside the complete, losslessly-cloned Spec.

import { cloneJson, queryDescription, queryName, queryPanel, upgradeSavedQuery } from './saved-query.js';
import type { QueryRoot } from './saved-query.js';
import { decodeLibraryJson, throwingValue } from './library-codec.js';
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

function invalidSpecError(query: { id?: unknown }, index: number, diag: SpecDiagnostic): never {
  const identity = query.id ? `Query ${JSON.stringify(query.id)}` : `Query at index ${index}`;
  throw new Error(`${identity}: ${diag.message}.`);
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
