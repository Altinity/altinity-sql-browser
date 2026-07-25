// Concrete v1 resource limits for portable bundles, stored workspaces, and
// Dashboard documents — verbatim from issue #280 "Resource limits". The JSON
// Schemas enforce the item/property/string-length bounds that are expressible
// there; the codec layer enforces the byte/depth bounds before parsing; the
// semantic validator re-checks the security-relevant limits after parsing.
//
// Pinned decision (#283): the Phase-2 WorkspaceRepository is IndexedDB-backed,
// so `maxDecodedJsonBytes` follows #280's sizing rather than shrinking to a
// localStorage-sized quota.

export const PORTABLE_LIMITS = {
  // #427 doubled this from #280's 10 MiB, in step with `maxQueries` below and for
  // the same reason: the ownership migration adds one dedicated query copy per
  // Dashboard member, so it roughly DOUBLES a document. The cap is enforced on
  // ENCODE only, so at 10 MiB a stored workspace between ~5 and 10 MiB decoded and
  // migrated fine and then failed every subsequent commit with `limit-json-bytes`
  // — permanently read-only, with the migration re-running on each open and no
  // repair path. 20 MiB keeps every document that was committable before #427
  // committable after it.
  maxDecodedJsonBytes: 20 * 1024 * 1024,
  maxJsonDepth: 64,

  // #427 raised this from #280's 1000. The V3->V4 ownership migration clones one
  // dedicated query per Dashboard member, and a VALID v3 record can hold
  // maxQueries originals plus maxDashboards x (maxTilesPerDashboard +
  // maxFiltersPerDashboard) = 4224 member references. At 1000, migrating a
  // legitimate large workspace produced a record that fails validation on every
  // future open with no repair path, so the bound is the post-migration
  // worst case: 1000 + 4224. Applies to portable bundles too, so a migrated
  // workspace stays exportable (an older build will reject a very large new
  // bundle — a deliberate, documented consequence).
  maxQueries: 5224,
  maxDashboards: 32,
  maxTilesPerDashboard: 100,
  maxFiltersPerDashboard: 32,
  maxLayoutItemsPerDashboard: 100,
  maxVariantsPerQuery: 32,

  maxIdLength: 256,
  maxNameLength: 512,
  maxTitleLength: 512,
  maxDescriptionLength: 16 * 1024,
  maxSqlLength: 1024 * 1024,

  maxSerializedQuerySpecBytes: 1024 * 1024,
  maxSerializedLayoutConfigBytes: 256 * 1024,
  maxSerializedFilterDefaultBytes: 64 * 1024,
} as const;

export type PortableLimits = typeof PORTABLE_LIMITS;
