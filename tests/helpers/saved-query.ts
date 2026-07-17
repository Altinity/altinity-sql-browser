// Concise canonical saved-query fixture for unit tests — honestly typed
// against `SavedQueryV2` (ADR-0002 #267). `fixture`'s named fields land in
// `spec` (only when actually provided — omitting one never writes a literal
// `undefined` key); a caller-supplied `spec` is merged in LAST, so it wins
// over the same-named shorthand fields; any other key rides straight through
// onto the built spec via the rest/`extensions` catch-all (QuerySpecV1's own
// index signature covers forward-compatible extension fields) — except
// `specVersion: 1` inside that catch-all, which bypasses the shorthand
// entirely and hands back a fully custom `spec` untouched (`structuredClone`d)
// for tests exercising a pre-built Spec document directly.
import type { Dashboard, Panel, QuerySpecV1, SavedQueryV2 } from '../../src/generated/json-schema.types.js';

export interface SavedQueryFixture {
  id?: string;
  sql?: string;
  name?: string;
  favorite?: boolean;
  description?: string;
  view?: QuerySpecV1['view'];
  panel?: Panel;
  dashboard?: Dashboard;
  spec?: Record<string, unknown>;
  // Arbitrary extension fields (e.g. `extension`, or `specVersion: 1` — see
  // above) — QuerySpecV1's own index signature accepts the same.
  [k: string]: unknown;
}

export function savedQuery(fixture: SavedQueryFixture = {}): SavedQueryV2 {
  const {
    id, sql = '', name = 'Untitled', favorite = false, description, view, panel, dashboard, spec = {},
    ...extensions
  } = fixture;
  if (extensions.specVersion === 1) {
    return { id: id ?? '', sql, specVersion: 1, spec: structuredClone(spec) as QuerySpecV1 };
  }
  return {
    id: id ?? '',
    sql,
    specVersion: 1,
    spec: {
      name,
      favorite,
      ...(description !== undefined ? { description } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(panel !== undefined ? { panel } : {}),
      ...(dashboard !== undefined ? { dashboard } : {}),
      ...extensions,
      ...spec,
    },
  };
}
