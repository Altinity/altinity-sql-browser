// Canonical portable Library parsing, validation, migration, decoding and
// encoding. Pure: validators, clocks, and id generation are injected.

import { schemasById } from '../generated/json-schemas.js';
import { validatorsById } from '../generated/json-schema-validators.js';
import { createJsonSchemaValidationService, formatJsonPath } from './json-schema-validation.js';
import { cloneJson, isPlainObject, upgradeV1Query } from './saved-query.js';
import { migrateLibraryV1ToV2, migrateSequential } from './library-migrations.js';
import { migrateSavedQuerySpec as migrateSpec } from './spec-migrations.js';

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

export const jsonSchemaValidationService = createJsonSchemaValidationService({
  schemasById,
  validatorsById,
});

const diagnostic = (path, code, message) => ({ path, severity: 'error', code, message });
const resultError = (...diagnostics) => ({ ok: false, diagnostics: diagnostics.flat() });

function validateLegacyLibraryV1(document) {
  if (!isPlainObject(document)) return [diagnostic([], 'library-invalid-root', 'Library document must be an object')];
  if (document.format !== LIBRARY_FORMAT) return [diagnostic(['format'], 'library-invalid-format', 'Unrecognized file format')];
  if (document.version !== 1) return [diagnostic(['version'], 'library-invalid-version', 'Library version must equal 1')];
  if (!Array.isArray(document.queries)) return [diagnostic(['queries'], 'schema-invalid-type', 'queries must be array')];
  if (document.queries.length > MAX_LIBRARY_QUERIES) {
    return [diagnostic(['queries'], 'schema-array-size', `queries must contain at most ${MAX_LIBRARY_QUERIES} items`)];
  }
  return [];
}

function identifyLibraryVersion(document) {
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
  if (!LIBRARY_CODECS.has(document.version)) {
    return resultError(diagnostic(
      ['version'], 'library-version-unsupported', `Unsupported Library version ${document.version}`,
    ));
  }
  return { ok: true, value: document.version };
}

function unsupportedSpecDiagnostic(query, index) {
  if (!isPlainObject(query) || !Number.isInteger(query.specVersion) || SPEC_CODECS.has(query.specVersion)) return null;
  const path = ['queries', index, 'specVersion'];
  return diagnostic(
    path,
    'spec-version-unsupported',
    `${formatJsonPath(path)} uses unsupported saved-query Spec version ${query.specVersion}`,
  );
}

function duplicateIdDiagnostics(queries) {
  const first = new Map();
  const diagnostics = [];
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

function validateLibraryV2Source(document, { validationService = jsonSchemaValidationService } = {}) {
  if (Array.isArray(document?.queries) && document.queries.length > MAX_LIBRARY_QUERIES) {
    return [diagnostic(['queries'], 'schema-array-size', `queries must contain at most ${MAX_LIBRARY_QUERIES} items`)];
  }
  const unsupportedSpecs = [];
  if (Array.isArray(document?.queries)) {
    for (const [index, query] of document.queries.entries()) {
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
  const duplicates = Array.isArray(document?.queries) ? duplicateIdDiagnostics(document.queries) : [];
  return [...unsupportedSpecs, ...structural, ...duplicates];
}

export const SPEC_CODECS = new Map([
  [1, {
    schemaId: QUERY_SPEC_V1_SCHEMA_ID,
    validateSource(value, { validationService = jsonSchemaValidationService } = {}) {
      return validationService.validate(QUERY_SPEC_V1_SCHEMA_ID, value);
    },
    migrateToNext: null,
  }],
]);

export const LIBRARY_CODECS = new Map([
  [1, {
    validateSource: validateLegacyLibraryV1,
    migrateToNext(document, context) {
      return migrateLibraryV1ToV2(document, { ...context, schemaId: LIBRARY_V2_SCHEMA_ID });
    },
  }],
  [2, {
    schemaId: LIBRARY_V2_SCHEMA_ID,
    validateSource: validateLibraryV2Source,
    migrateToNext: null,
  }],
]);

export function parseJsonDocument(text) {
  try {
    return { ok: true, value: JSON.parse(String(text)) };
  } catch {
    return resultError(diagnostic([], 'json-syntax', 'Not a valid JSON file'));
  }
}

export function validateSavedQueryDocument(query, { validationService = jsonSchemaValidationService } = {}) {
  if (isPlainObject(query) && Number.isInteger(query.specVersion) && !SPEC_CODECS.has(query.specVersion)) {
    return [diagnostic(['specVersion'], 'spec-version-unsupported',
      `specVersion uses unsupported saved-query Spec version ${query.specVersion}`)];
  }
  return validationService.validate(SAVED_QUERY_V2_SCHEMA_ID, query).map((item) => ({
    ...item,
    schemaId: item.path[0] === 'spec' ? QUERY_SPEC_V1_SCHEMA_ID : SAVED_QUERY_V2_SCHEMA_ID,
  }));
}

export function validateLibraryDocument(document, options = {}) {
  const identified = identifyLibraryVersion(document);
  if (!identified.ok) return identified.diagnostics;
  return LIBRARY_CODECS.get(identified.value).validateSource(document, options);
}

export function migrateLibraryDocument(document, targetVersion = CURRENT_LIBRARY_VERSION, options = {}) {
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

export function migrateSavedQuerySpec(query, targetSpecVersion, options = {}) {
  const before = validateSavedQueryDocument(query, options);
  if (before.length) return { ok: false, diagnostics: before };
  const migrated = migrateSpec(query, targetSpecVersion, { codecs: SPEC_CODECS, context: options });
  if (!migrated.ok) return migrated;
  const after = validateSavedQueryDocument(migrated.value, options);
  return after.length ? { ok: false, diagnostics: after } : migrated;
}

export function decodeLibraryDocument(document, options = {}) {
  const migrated = migrateLibraryDocument(document, CURRENT_LIBRARY_VERSION, options);
  if (!migrated.ok) return migrated;
  const canonical = migrated.value;
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

export function decodeLibraryJson(text, options = {}) {
  const parsed = parseJsonDocument(text);
  return parsed.ok ? decodeLibraryDocument(parsed.value, options) : parsed;
}

export function encodeLibraryDocument(queries, {
  nowISO,
  includeSchemaHint = true,
  validationService = jsonSchemaValidationService,
} = {}) {
  if (!Array.isArray(queries)) return resultError(diagnostic(['queries'], 'schema-invalid-type', 'queries must be array'));
  if (typeof nowISO !== 'string' || !nowISO) {
    return resultError(diagnostic(['exportedAt'], 'schema-required', 'exportedAt is required for new exports'));
  }
  const document = {
    ...(includeSchemaHint ? { $schema: LIBRARY_V2_SCHEMA_ID } : {}),
    format: LIBRARY_FORMAT,
    version: CURRENT_LIBRARY_VERSION,
    exportedAt: nowISO,
    queries: queries.map((query) => isPlainObject(query) && ('spec' in query || 'specVersion' in query)
      ? cloneJson(query)
      : upgradeV1Query(query)),
  };
  const diagnostics = validateLibraryV2Source(document, { validationService });
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: cloneJson(document) };
}

export function encodeLibraryJson(queries, options = {}) {
  const encoded = encodeLibraryDocument(queries, options);
  return encoded.ok ? { ok: true, value: JSON.stringify(encoded.value, null, 2) } : encoded;
}

const defaultStoredId = (index, attempt) => `stored-${index + 1}${attempt ? `-${attempt}` : ''}`;

export function decodeStoredSavedQueries(value, {
  validationService = jsonSchemaValidationService,
  generateId = defaultStoredId,
} = {}) {
  if (!Array.isArray(value)) return resultError(diagnostic([], 'storage-invalid-root', 'Stored saved queries must be an array'));
  if (value.length > MAX_LIBRARY_QUERIES) {
    return resultError(diagnostic([], 'storage-array-size', `Stored saved queries must contain at most ${MAX_LIBRARY_QUERIES} items`));
  }
  const queries = [];
  const used = new Set();
  const freshId = (index) => {
    for (let attempt = 0; attempt <= MAX_LIBRARY_QUERIES; attempt++) {
      const id = String(generateId(index, attempt) || '').trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('Unable to generate a unique stored saved-query id');
  };

  for (const [index, raw] of value.entries()) {
    let query;
    if (isPlainObject(raw) && ('spec' in raw || 'specVersion' in raw)) {
      query = cloneJson(raw);
      if ((!Object.hasOwn(query, 'id') || typeof query.id !== 'string' || !query.id.trim())
        && query.specVersion === CURRENT_SPEC_VERSION && isPlainObject(query.spec) && typeof query.sql === 'string') {
        query.id = freshId(index);
      }
    } else {
      query = upgradeV1Query(raw);
      query.id = (typeof query.id === 'string' && query.id.trim()) ? query.id.trim() : freshId(index);
    }
    if (used.has(query.id)) query.id = freshId(index);
    const errors = validateSavedQueryDocument(query, { validationService });
    if (errors.length) {
      return { ok: false, value: [], diagnostics: errors.map((item) => ({
        ...item,
        path: [index, ...item.path],
        message: `Stored query ${formatJsonPath([index])}: ${item.message}`,
      })) };
    }
    used.add(query.id);
    queries.push({ id: query.id, sql: query.sql, specVersion: query.specVersion, spec: cloneJson(query.spec) });
  }
  return { ok: true, value: queries, diagnostics: [] };
}

export function getSchema(kind, version) {
  return Object.values(schemasById).find((schema) =>
    schema['x-altinity-kind'] === kind && schema['x-altinity-version'] === version);
}

export const getCurrentLibraryVersion = () => CURRENT_LIBRARY_VERSION;
export const getCurrentSpecVersion = () => CURRENT_SPEC_VERSION;

export function throwingValue(result) {
  if (result.ok) return result.value;
  const first = result.diagnostics[0] || diagnostic([], 'invalid-document', 'Invalid document');
  const error = new Error(first.message);
  error.diagnostics = result.diagnostics;
  throw error;
}
