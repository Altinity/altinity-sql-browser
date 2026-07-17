// Saved-query Presentation Spec migrations have their own registry and version
// axis, independent of the surrounding Library document version.

import { cloneJson, isPlainObject } from './saved-query.js';
import { migrateSequential } from './library-migrations.js';
import type { MigrationCodec, MigrationDiagnostic } from './library-migrations.js';

/** `migrateSavedQuerySpec`'s options bag — the codec registry `migrateSequential`
 *  walks, plus opaque context passed through to each codec unchanged. Unlike
 *  `migrateSequential`, `context` alone never defaults the whole bag — a caller
 *  must always name its codec registry (there is exactly one real caller,
 *  `library-codec.js`, and it always does). */
export interface MigrateSavedQuerySpecOptions {
  codecs: Map<number, MigrationCodec>;
  context?: unknown;
}

/** The migrated saved-query envelope on success — application-managed fields
 *  (`id`/`sql`) pass through verbatim from the input; only `spec` is what the
 *  codec chain actually migrated (deep-cloned), and `specVersion` becomes the
 *  requested target. Fields are `unknown` here (not `QueryRoot`'s stricter
 *  shape): this function itself never validates `id`/`sql`/`spec` beyond
 *  `isPlainObject(query)` and whatever `codecs` enforce. */
export interface MigratedSavedQuery {
  id: unknown;
  sql: unknown;
  specVersion: number;
  spec: unknown;
}

/** `migrateSavedQuerySpec`'s return shape — the same `{ok:true,value} |
 *  {ok:false,diagnostics}` discriminated contract as `migrateSequential`,
 *  plus the saved-query envelope folded back in on success. */
export type MigrateSavedQuerySpecResult =
  | { ok: true; value: MigratedSavedQuery }
  | { ok: false; diagnostics: MigrationDiagnostic[] };

export function migrateSavedQuerySpec(
  query: unknown,
  targetSpecVersion: number,
  { codecs, context = {} }: MigrateSavedQuerySpecOptions,
): MigrateSavedQuerySpecResult {
  if (!isPlainObject(query)) {
    return { ok: false, diagnostics: [{
      path: [], severity: 'error', code: 'saved-query-invalid', message: 'Saved query must be an object',
    }] };
  }
  const result = migrateSequential({
    value: query.spec,
    fromVersion: query.specVersion,
    toVersion: targetSpecVersion,
    codecs,
    context,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      id: query.id,
      sql: query.sql,
      specVersion: targetSpecVersion,
      spec: cloneJson(result.value),
    },
  };
}
