// Pure one-step Library migrations. No clock or id source is read here;
// callers inject both policies so migrations stay deterministic.

import { cloneJson, isPlainObject, upgradeV1Query } from './saved-query.js';

const failure = (code, message, path = []) => ({
  ok: false,
  diagnostics: [{ path, severity: 'error', code, message }],
});

export function migrateSequential({ value, fromVersion, toVersion, codecs, context = {} }) {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
    return failure('migration-invalid-version', 'Migration versions must be integers');
  }
  if (fromVersion > toVersion) return failure('migration-downgrade', 'Downgrade migrations are not supported');

  let current = cloneJson(value);
  const sourceCodec = codecs.get(fromVersion);
  if (!sourceCodec) return failure('migration-unsupported-version', `Unsupported version ${fromVersion}`, ['version']);
  const sourceErrors = sourceCodec.validateSource(current, context);
  if (sourceErrors.length) return { ok: false, diagnostics: sourceErrors };
  for (let version = fromVersion; version < toVersion; version++) {
    const codec = codecs.get(version);
    const next = codecs.get(version + 1);
    if (!next || typeof codec.migrateToNext !== 'function') {
      return failure('migration-missing-step', `No migration from version ${version} to ${version + 1}`, ['version']);
    }
    current = codec.migrateToNext(current, context);
    const after = next.validateSource(current, context);
    if (after.length) return { ok: false, diagnostics: after };
  }
  return { ok: true, value: current };
}

const defaultGenerateId = (index, attempt) => `legacy-${index + 1}${attempt ? `-${attempt}` : ''}`;

export function migrateLibraryV1ToV2(document, {
  nowISO,
  generateId = defaultGenerateId,
  includeSchemaHint = true,
  schemaId = 'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json',
} = {}) {
  const used = new Set();
  const freshId = (index) => {
    for (let attempt = 0; attempt <= 1000; attempt++) {
      const id = String(generateId(index, attempt) || '').trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('Unable to generate a unique legacy saved-query id');
  };

  const queries = [];
  for (const [index, raw] of document.queries.entries()) {
    // Historical v1 behavior is deliberately forgiving: malformed rows were
    // skipped, not partially imported.
    if (!isPlainObject(raw) || typeof raw.sql !== 'string') continue;
    const query = upgradeV1Query(raw);
    const candidate = typeof query.id === 'string' ? query.id.trim() : '';
    query.id = candidate && !used.has(candidate) ? candidate : freshId(index);
    used.add(query.id);
    queries.push(query);
  }

  const migrated = {
    ...(includeSchemaHint ? { $schema: schemaId } : {}),
    format: 'altinity-sql-browser/saved-queries',
    version: 2,
    ...((typeof nowISO === 'string' && nowISO) ? { exportedAt: nowISO } : {}),
    queries,
  };
  return cloneJson(migrated);
}
