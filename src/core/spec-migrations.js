// Saved-query Presentation Spec migrations have their own registry and version
// axis, independent of the surrounding Library document version.

import { cloneJson, isPlainObject } from './saved-query.js';
import { migrateSequential } from './library-migrations.js';

export function migrateSavedQuerySpec(query, targetSpecVersion, { codecs, context = {} } = {}) {
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
