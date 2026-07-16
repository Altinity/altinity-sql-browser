// Pure one-step Library migrations. No clock or id source is read here;
// callers inject both policies so migrations stay deterministic.

import { cloneJson, isPlainObject, upgradeV1Query } from './saved-query.js';
import type { QueryRoot } from './saved-query.js';

/** One migration-path diagnostic — the same `{path, severity, code, message}`
 *  shape every migration/validation failure in this module reports. */
export interface MigrationDiagnostic {
  path: (string | number)[];
  severity: 'error';
  code: string;
  message: string;
}

/** One version's codec: validate a value claimed to be at this version, and
 *  (unless this is the final target version) migrate it to the next one. */
export interface MigrationCodec {
  validateSource: (value: unknown, context?: unknown) => MigrationDiagnostic[];
  migrateToNext?: ((value: unknown, context?: unknown) => unknown) | null;
}

/** `migrateSequential`'s options bag. `fromVersion`/`toVersion` are
 *  deliberately `unknown` — a non-integer value is a first-class rejected
 *  input (`migration-invalid-version`), not a caller contract. */
export interface MigrateSequentialInput {
  value: unknown;
  fromVersion: unknown;
  toVersion: unknown;
  codecs: Map<number, MigrationCodec>;
  context?: unknown;
}

/** `migrateSequential`'s return shape. */
export type MigrateSequentialResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostics: MigrationDiagnostic[] };

const failure = (code: string, message: string, path: (string | number)[] = []): MigrateSequentialResult => ({
  ok: false,
  diagnostics: [{ path, severity: 'error', code, message }],
});

export function migrateSequential({ value, fromVersion, toVersion, codecs, context = {} }: MigrateSequentialInput): MigrateSequentialResult {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
    return failure('migration-invalid-version', 'Migration versions must be integers');
  }
  // Verified integers above — targeted casts pin the honest, narrower type
  // the rest of this function relies on (same convention as the unconverted-
  // sibling wrapper casts elsewhere in src/core).
  const from = fromVersion as number;
  const to = toVersion as number;
  if (from > to) return failure('migration-downgrade', 'Downgrade migrations are not supported');

  let current = cloneJson(value);
  const sourceCodec = codecs.get(from);
  if (!sourceCodec) return failure('migration-unsupported-version', `Unsupported version ${from}`, ['version']);
  const sourceErrors = sourceCodec.validateSource(current, context);
  if (sourceErrors.length) return { ok: false, diagnostics: sourceErrors };
  for (let version = from; version < to; version++) {
    // Invariant: reaching this iteration means the previous step's `next`
    // check (or, for the first iteration, `sourceCodec` above) already
    // confirmed a codec exists at `version` — see the loop's own
    // `!next || …` guard below, which returns before any *later* version is
    // ever reached without its codec present.
    const codec = codecs.get(version)!;
    const next = codecs.get(version + 1);
    const migrate = codec.migrateToNext;
    if (!next || typeof migrate !== 'function') {
      return failure('migration-missing-step', `No migration from version ${version} to ${version + 1}`, ['version']);
    }
    current = migrate(current, context);
    const after = next.validateSource(current, context);
    if (after.length) return { ok: false, diagnostics: after };
  }
  return { ok: true, value: current };
}

const defaultGenerateId = (index: number, attempt: number): string => `legacy-${index + 1}${attempt ? `-${attempt}` : ''}`;

/** `migrateLibraryV1ToV2`'s options bag. */
export interface MigrateLibraryV1ToV2Options {
  nowISO?: string;
  generateId?: (index: number, attempt: number) => string;
  includeSchemaHint?: boolean;
  schemaId?: string;
}

/** The migrated Library v2 document `migrateLibraryV1ToV2` returns. */
export interface MigratedLibraryV2 {
  $schema?: string;
  format: string;
  version: number;
  exportedAt?: string;
  queries: QueryRoot[];
}

export function migrateLibraryV1ToV2(document: { queries: unknown[] }, {
  nowISO,
  generateId = defaultGenerateId,
  includeSchemaHint = true,
  schemaId = 'https://altinity.com/schemas/altinity-sql-browser/library-v2.schema.json',
}: MigrateLibraryV1ToV2Options = {}): MigratedLibraryV2 {
  const used = new Set<string>();
  const freshId = (index: number): string => {
    for (let attempt = 0; attempt <= 1000; attempt++) {
      const id = String(generateId(index, attempt) || '').trim();
      if (id && !used.has(id)) return id;
    }
    throw new Error('Unable to generate a unique legacy saved-query id');
  };

  const queries: QueryRoot[] = [];
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

  const migrated: MigratedLibraryV2 = {
    ...(includeSchemaHint ? { $schema: schemaId } : {}),
    format: 'altinity-sql-browser/saved-queries',
    version: 2,
    ...((typeof nowISO === 'string' && nowISO) ? { exportedAt: nowISO } : {}),
    queries,
  };
  return cloneJson(migrated);
}
