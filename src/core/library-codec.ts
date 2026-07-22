// Canonical portable Library parsing, validation, migration, decoding and
// encoding. Pure: validators, clocks, and id generation are injected.

import { schemasById } from '../generated/json-schemas.js';
import { validatorsById } from '../generated/json-schema-validators.js';
import { createJsonSchemaValidationService, formatJsonPath } from './json-schema-validation.js';
import type { JsonSchemaValidationService, JsonSchemaValidatorFn } from './json-schema-validation.js';
import { cloneJson, isPlainObject, upgradeV1Query } from './saved-query.js';
import { migrateLibraryV1ToV2, migrateSequential } from './library-migrations.js';
import type { MigratedLibraryV2, MigrateSequentialResult } from './library-migrations.js';
import { migrateSavedQuerySpec as migrateSpec } from './spec-migrations.js';
import type { MigratedSavedQuery } from './spec-migrations.js';
import { hasSameTimeRangeParameter } from './query-time-range.js';

export const LIBRARY_FORMAT = 'altinity-sql-browser/saved-queries';
export const CURRENT_LIBRARY_VERSION = 2;
export const CURRENT_SPEC_VERSION = 1;
export const MAX_LIBRARY_QUERIES = 1000;
export const QUERY_SPEC_V1_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/query-spec-v1.schema.json';
export const SAVED_QUERY_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/saved-query-v2.schema.json';
export const LIBRARY_V2_SCHEMA_ID =
  'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json';

// `../generated/*.js` are build-emitted plain JS (never hand-typed) — a
// typed wrapper over exactly the shape this module reads: a schema is an
// arbitrary JSON Schema object (bracket-accessed below), a compiled
// validator is the same `JsonSchemaValidatorFn` contract json-schema-
// validation.ts already declares for every consumer of these two modules.
const typedSchemasById = schemasById as Record<string, Record<string, unknown>>;
const typedValidatorsById = validatorsById as Record<string, JsonSchemaValidatorFn>;

export const jsonSchemaValidationService: JsonSchemaValidationService = createJsonSchemaValidationService({
  schemasById: typedSchemasById,
  validatorsById: typedValidatorsById,
});

/** One Library/saved-query/Spec validation diagnostic — every diagnostic this
 *  module produces (its own `diagnostic()` factory below, and re-tagged
 *  JSON-Schema errors from `jsonSchemaValidationService`) is always severity
 *  `'error'`. Deliberately just these four fields (no index signature): the
 *  schema-derived diagnostics (json-schema-validation.ts's `SchemaDiagnostic`,
 *  which carries extra `keyword`/`schemaId`) and library-migrations.ts's
 *  narrower `MigrationDiagnostic` both structurally satisfy this shape either
 *  way — an index signature here would only get in the way of accepting the
 *  narrower one back from `migrateSequential`/`migrateSavedQuerySpec`. */
export interface LibraryDiagnostic {
  path: (string | number)[];
  severity: 'error';
  code: string;
  message: string;
}

const diagnostic = (path: (string | number)[], code: string, message: string): LibraryDiagnostic =>
  ({ path, severity: 'error', code, message });

type FailResult = { ok: false; diagnostics: LibraryDiagnostic[] };
const resultError = (...diagnostics: (LibraryDiagnostic | LibraryDiagnostic[])[]): FailResult =>
  ({ ok: false, diagnostics: diagnostics.flat() });

const timeRangeSemanticDiagnostics = (spec: unknown, path: (string | number)[] = []): LibraryDiagnostic[] =>
  hasSameTimeRangeParameter(spec)
    ? [diagnostic([...path, 'timeRanges', 0, 'to'], 'time-range-same-parameter',
      'Time-range From and To parameters must be different.')]
    : [];

function validateLegacyLibraryV1(document: unknown): LibraryDiagnostic[] {
  // Version identification establishes the v1 envelope before this codec runs.
  const queries = (document as { queries?: unknown }).queries;
  if (!Array.isArray(queries)) return [diagnostic(['queries'], 'schema-invalid-type', 'queries must be array')];
  if (queries.length > MAX_LIBRARY_QUERIES) {
    return [diagnostic(['queries'], 'schema-array-size', `queries must contain at most ${MAX_LIBRARY_QUERIES} items`)];
  }
  return [];
}

function identifyLibraryVersion(document: unknown): { ok: true; value: number } | FailResult {
  if (!isPlainObject(document)) return resultError(diagnostic([], 'library-invalid-root', 'Unrecognized file format'));
  if (document.format !== LIBRARY_FORMAT) {
    return resultError(diagnostic(['format'], 'library-invalid-format', 'Unrecognized file format'));
  }
  if (!Object.hasOwn(document, 'version')) {
    return resultError(diagnostic(['version'], 'library-version-missing', 'Missing Library version'));
  }
  if (!Number.isInteger(document.version)) {
    return resultError(diagnostic(['version'], 'library-version-invalid', 'Invalid Library version'));
  }
  if (!LIBRARY_CODECS.has(document.version as number)) {
    return resultError(diagnostic(
      ['version'], 'library-version-unsupported', `Unsupported Library version ${document.version}`,
    ));
  }
  return { ok: true, value: document.version as number };
}

function unsupportedSpecDiagnostic(query: unknown, index: number): LibraryDiagnostic | null {
  if (!isPlainObject(query) || !Number.isInteger(query.specVersion) || SPEC_CODECS.has(query.specVersion as number)) return null;
  const path: (string | number)[] = ['queries', index, 'specVersion'];
  return diagnostic(
    path,
    'spec-version-unsupported',
    `${formatJsonPath(path)} uses unsupported saved-query Spec version ${query.specVersion}`,
  );
}

function duplicateIdDiagnostics(queries: unknown[]): LibraryDiagnostic[] {
  const first = new Map<string, number>();
  const diagnostics: LibraryDiagnostic[] = [];
  for (const [index, query] of queries.entries()) {
    if (!isPlainObject(query) || typeof query.id !== 'string') continue;
    if (first.has(query.id)) {
      diagnostics.push(diagnostic(
        ['queries', index, 'id'],
        'library-duplicate-query-id',
        `Saved-query id ${JSON.stringify(query.id)} duplicates queries[${first.get(query.id)}].id`,
      ));
    } else first.set(query.id, index);
  }
  return diagnostics;
}

function validateLibraryV2Source(document: unknown, options?: unknown): LibraryDiagnostic[] {
  // `options` matches `MigrationCodec.validateSource`'s own `context?: unknown`
  // exactly (this codec's `validateSource` is stored in `LIBRARY_CODECS`,
  // which every codec-framework caller — `migrateSequential`,
  // `validateLibraryDocument` — invokes generically); narrowed here to what
  // this module actually passes.
  // `!`: both real callers default their bag to `{}` before it ever reaches
  // here, so `options` is never nullish in practice — the original .js's
  // parameter-default destructuring covered exactly this same "always an
  // object by the time it's read" case.
  const { validationService = jsonSchemaValidationService } =
    options as { validationService?: JsonSchemaValidationService };
  // Ingress: `document` is arbitrary caller-supplied JSON — `queries` is read
  // defensively (present, an array, or not) rather than asserting a shape.
  const doc = document as { queries?: unknown } | null | undefined;
  const queries = Array.isArray(doc?.queries) ? doc.queries : undefined;
  if (queries && queries.length > MAX_LIBRARY_QUERIES) {
    return [diagnostic(['queries'], 'schema-array-size', `queries must contain at most ${MAX_LIBRARY_QUERIES} items`)];
  }
  const unsupportedSpecs: LibraryDiagnostic[] = [];
  if (queries) {
    for (const [index, query] of queries.entries()) {
      const unsupported = unsupportedSpecDiagnostic(query, index);
      if (unsupported) unsupportedSpecs.push(unsupported);
    }
  }
  const unsupportedIndexes = new Set(unsupportedSpecs.map((item) => item.path[1]));
  const structural = validationService.validate(LIBRARY_V2_SCHEMA_ID, document)
    // The manual unsupported-version diagnostic is authoritative and concise;
    // discard only the selected branch noise for that same query.
    .filter((item) => !(item.path[0] === 'queries' && unsupportedIndexes.has(item.path[1])))
    .map((item) => ({
      ...item,
      schemaId: item.path[0] === 'queries' && item.path.length >= 4 && item.path[2] === 'spec'
        ? QUERY_SPEC_V1_SCHEMA_ID
        : item.path[0] === 'queries' && item.path.length >= 3
          ? SAVED_QUERY_V2_SCHEMA_ID
          : LIBRARY_V2_SCHEMA_ID,
    }));
  const semantics = queries ? queries.flatMap((query, index) =>
    isPlainObject(query) && !unsupportedIndexes.has(index)
      ? timeRangeSemanticDiagnostics(query.spec, ['queries', index, 'spec']) : []) : [];
  const duplicates = queries ? duplicateIdDiagnostics(queries) : [];
  return [...unsupportedSpecs, ...structural, ...semantics, ...duplicates];
}

/** One saved-query Spec version's codec — `library-migrations.ts`'s
 *  `MigrationCodec` shape, `LibraryDiagnostic`-typed, plus this entry's own
 *  canonical schema id. */
interface SpecCodecEntry {
  schemaId?: string;
  validateSource: (value: unknown, options?: unknown) => LibraryDiagnostic[];
  migrateToNext: ((value: unknown, context?: unknown) => unknown) | null;
}

export const SPEC_CODECS: Map<number, SpecCodecEntry> = new Map([
  [1, {
    schemaId: QUERY_SPEC_V1_SCHEMA_ID,
    validateSource(value: unknown, options?: unknown): LibraryDiagnostic[] {
      // `!`: reached only through `migrateSequential`, whose `context` bag
      // always defaults to `{}` before it's passed down — never nullish here,
      // same as `validateLibraryV2Source` above.
      const { validationService = jsonSchemaValidationService } =
        options as { validationService?: JsonSchemaValidationService };
      return [
        ...validationService.validate(QUERY_SPEC_V1_SCHEMA_ID, value),
        ...timeRangeSemanticDiagnostics(value),
      ];
    },
    migrateToNext: null,
  }],
]);

/** One Library version's codec — same shape as `SpecCodecEntry` above. */
interface LibraryCodecEntry {
  schemaId?: string;
  validateSource: (document: unknown, options?: unknown) => LibraryDiagnostic[];
  migrateToNext: ((document: unknown, context?: unknown) => unknown) | null;
}

export const LIBRARY_CODECS: Map<number, LibraryCodecEntry> = new Map([
  [1, {
    validateSource: validateLegacyLibraryV1,
    migrateToNext(document: unknown, context?: unknown): MigratedLibraryV2 {
      // `!`: `context` is this codec framework's opaque per-call bag —
      // `migrateSequential` always defaults it to `{}` before calling
      // `migrateToNext`, so it's never nullish here (the original .js spread
      // `context` bare with no fallback at all — spreading `undefined` is a
      // harmless no-op, so it never needed one either); `document` reaches
      // here only after `validateLegacyLibraryV1` already confirmed a
      // `{queries: [...]}` shape (`migrateSequential` validates before
      // migrating).
      const ctx = context as Record<string, unknown>;
      return migrateLibraryV1ToV2(document as { queries: unknown[] }, { ...ctx, schemaId: LIBRARY_V2_SCHEMA_ID });
    },
  }],
  [2, {
    schemaId: LIBRARY_V2_SCHEMA_ID,
    validateSource: validateLibraryV2Source,
    migrateToNext: null,
  }],
]);

export function parseJsonDocument(text: unknown): { ok: true; value: unknown } | FailResult {
  try {
    return { ok: true, value: JSON.parse(String(text)) };
  } catch {
    return resultError(diagnostic([], 'json-syntax', 'Not a valid JSON file'));
  }
}

export function validateSavedQueryDocument(
  query: unknown, { validationService = jsonSchemaValidationService }: { validationService?: JsonSchemaValidationService } = {},
): LibraryDiagnostic[] {
  if (isPlainObject(query) && Number.isInteger(query.specVersion) && !SPEC_CODECS.has(query.specVersion as number)) {
    return [diagnostic(['specVersion'], 'spec-version-unsupported',
      `specVersion uses unsupported saved-query Spec version ${query.specVersion}`)];
  }
  const structural = validationService.validate(SAVED_QUERY_V2_SCHEMA_ID, query).map((item) => ({
    ...item,
    schemaId: item.path[0] === 'spec' ? QUERY_SPEC_V1_SCHEMA_ID : SAVED_QUERY_V2_SCHEMA_ID,
  }));
  const semantics = isPlainObject(query) ? timeRangeSemanticDiagnostics(query.spec, ['spec']) : [];
  return [...structural, ...semantics];
}

export function validateLibraryDocument(
  document: unknown, options: { validationService?: JsonSchemaValidationService } = {},
): LibraryDiagnostic[] {
  const identified = identifyLibraryVersion(document);
  if (!identified.ok) return identified.diagnostics;
  // `identified.value` only ever reaches here after `LIBRARY_CODECS.has(...)`
  // already confirmed the entry exists (see `identifyLibraryVersion`).
  return LIBRARY_CODECS.get(identified.value)!.validateSource(document, options);
}

export function migrateLibraryDocument(
  document: unknown, targetVersion: number = CURRENT_LIBRARY_VERSION, options: Record<string, unknown> = {},
): MigrateSequentialResult {
  const identified = identifyLibraryVersion(document);
  if (!identified.ok) return identified;
  return migrateSequential({
    value: document,
    fromVersion: identified.value,
    toVersion: targetVersion,
    codecs: LIBRARY_CODECS,
    context: options,
  });
}

export function migrateSavedQuerySpec(
  query: unknown, targetSpecVersion: number, options: { validationService?: JsonSchemaValidationService } = {},
): { ok: true; value: MigratedSavedQuery } | FailResult {
  const before = validateSavedQueryDocument(query, options);
  if (before.length) return { ok: false, diagnostics: before };
  const migrated = migrateSpec(query, targetSpecVersion, { codecs: SPEC_CODECS, context: options });
  if (!migrated.ok) return migrated;
  const after = validateSavedQueryDocument(migrated.value, options);
  return after.length ? { ok: false, diagnostics: after } : migrated;
}

/** `decodeLibraryDocument`'s success value — the canonical portable Library
 *  contents, deep-cloned. */
export interface DecodedLibrary {
  libraryVersion: unknown;
  format: unknown;
  exportedAt: unknown;
  schema: unknown;
  queries: unknown;
}

export function decodeLibraryDocument(
  document: unknown, options: Record<string, unknown> = {},
): { ok: true; value: DecodedLibrary } | FailResult {
  const migrated = migrateLibraryDocument(document, CURRENT_LIBRARY_VERSION, options);
  if (!migrated.ok) return migrated;
  // `migrated.value` is always a canonical Library v2 document once migration
  // succeeds (`migrateLibraryV1ToV2` / `validateLibraryV2Source` shape).
  const canonical = migrated.value as {
    version: unknown; format: unknown; exportedAt?: unknown; $schema?: unknown; queries: unknown;
  };
  return {
    ok: true,
    value: {
      libraryVersion: canonical.version,
      format: canonical.format,
      exportedAt: canonical.exportedAt ?? null,
      schema: canonical.$schema ?? null,
      queries: cloneJson(canonical.queries),
    },
  };
}

export function decodeLibraryJson(
  text: unknown, options: Record<string, unknown> = {},
): { ok: true; value: DecodedLibrary } | FailResult {
  const parsed = parseJsonDocument(text);
  return parsed.ok ? decodeLibraryDocument(parsed.value, options) : parsed;
}

export function encodeLibraryDocument(queries: unknown, {
  nowISO,
  includeSchemaHint = true,
  validationService = jsonSchemaValidationService,
}: { nowISO?: string; includeSchemaHint?: boolean; validationService?: JsonSchemaValidationService } = {}):
  { ok: true; value: Record<string, unknown> } | FailResult {
  if (!Array.isArray(queries)) return resultError(diagnostic(['queries'], 'schema-invalid-type', 'queries must be array'));
  if (typeof nowISO !== 'string' || !nowISO) {
    return resultError(diagnostic(['exportedAt'], 'schema-required', 'exportedAt is required for new exports'));
  }
  const document: Record<string, unknown> = {
    ...(includeSchemaHint ? { $schema: LIBRARY_V2_SCHEMA_ID } : {}),
    format: LIBRARY_FORMAT,
    version: CURRENT_LIBRARY_VERSION,
    exportedAt: nowISO,
    queries: queries.map((query: unknown) => isPlainObject(query) && ('spec' in query || 'specVersion' in query)
      ? cloneJson(query)
      : upgradeV1Query(query)),
  };
  const diagnostics = validateLibraryV2Source(document, { validationService });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: cloneJson(document) };
}

export function encodeLibraryJson(
  queries: unknown,
  options: { nowISO?: string; includeSchemaHint?: boolean; validationService?: JsonSchemaValidationService } = {},
): { ok: true; value: string } | FailResult {
  const encoded = encodeLibraryDocument(queries, options);
  return encoded.ok ? { ok: true, value: JSON.stringify(encoded.value, null, 2) } : encoded;
}

const defaultStoredId = (index: number, attempt: number): string => `stored-${index + 1}${attempt ? `-${attempt}` : ''}`;

/** One decoded stored (localStorage) saved query — the canonical
 *  `{id, sql, specVersion, spec}` shape, `id` always a non-blank string. */
export interface StoredSavedQuery {
  id: string;
  sql: unknown;
  specVersion: unknown;
  spec: unknown;
}

export interface DecodeStoredOptions {
  validationService?: JsonSchemaValidationService;
  generateId?: (index: number, attempt: number) => string;
}

// The in-flight query being normalized inside `decodeStoredSavedQueries`'s
// loop below — deliberately no index signature (unlike `Record<string,
// unknown>`): `upgradeV1Query`'s `QueryRoot` return (a plain interface, no
// index signature of its own) assigns straight into this shape, whereas it
// would NOT satisfy an index-signature-bearing target.
interface MutableStoredQuery {
  id?: unknown;
  sql?: unknown;
  specVersion?: unknown;
  spec?: unknown;
}

export type DecodeStoredSavedQueriesResult =
  | { ok: true; value: StoredSavedQuery[]; diagnostics: [] }
  | { ok: false; value?: never[]; diagnostics: LibraryDiagnostic[] };

export function decodeStoredSavedQueries(
  value: unknown, {
    validationService = jsonSchemaValidationService,
    generateId = defaultStoredId,
  }: DecodeStoredOptions = {},
): DecodeStoredSavedQueriesResult {
  if (!Array.isArray(value)) return resultError(diagnostic([], 'storage-invalid-root', 'Stored saved queries must be an array'));
  if (value.length > MAX_LIBRARY_QUERIES) {
    return resultError(diagnostic([], 'storage-array-size', `Stored saved queries must contain at most ${MAX_LIBRARY_QUERIES} items`));
  }
  const queries: StoredSavedQuery[] = [];
  const used = new Set<string>();
  const freshId = (index: number): string => {
    for (let attempt = 0; attempt <= MAX_LIBRARY_QUERIES; attempt++) {
      const id = String(generateId(index, attempt) || '').trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('Unable to generate a unique stored saved-query id');
  };

  for (const [index, raw] of value.entries()) {
    let query: MutableStoredQuery;
    if (isPlainObject(raw) && ('spec' in raw || 'specVersion' in raw)) {
      query = cloneJson(raw);
      if ((!Object.hasOwn(query, 'id') || typeof query.id !== 'string' || !(query.id as string).trim())
        && query.specVersion === CURRENT_SPEC_VERSION && isPlainObject(query.spec) && typeof query.sql === 'string') {
        query.id = freshId(index);
      }
    } else {
      query = upgradeV1Query(raw);
      query.id = (typeof query.id === 'string' && (query.id as string).trim()) ? (query.id as string).trim() : freshId(index);
    }
    if (used.has(query.id as string)) query.id = freshId(index);
    const errors = validateSavedQueryDocument(query, { validationService });
    if (errors.length) {
      return { ok: false, value: [], diagnostics: errors.map((item) => ({
        ...item,
        path: [index, ...item.path],
        message: `Stored query ${formatJsonPath([index])}: ${item.message}`,
      })) };
    }
    used.add(query.id as string);
    queries.push({ id: query.id as string, sql: query.sql, specVersion: query.specVersion, spec: cloneJson(query.spec) });
  }
  return { ok: true, value: queries, diagnostics: [] };
}

export function getSchema(kind: string, version: number): unknown {
  return Object.values(typedSchemasById).find((schema) =>
    schema['x-altinity-kind'] === kind && schema['x-altinity-version'] === version);
}

export const getCurrentLibraryVersion = (): number => CURRENT_LIBRARY_VERSION;
export const getCurrentSpecVersion = (): number => CURRENT_SPEC_VERSION;

export function throwingValue<T>(result: { ok: true; value: T } | { ok: false; diagnostics: LibraryDiagnostic[] }): T {
  if (result.ok) return result.value;
  const first = result.diagnostics[0] || diagnostic([], 'invalid-document', 'Invalid document');
  const error = new Error(first.message) as Error & { diagnostics?: LibraryDiagnostic[] };
  error.diagnostics = result.diagnostics;
  throw error;
}
