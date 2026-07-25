// Concrete v1 resource limits for portable bundles, stored workspaces, and
// Dashboard documents — verbatim from issue #280 "Resource limits". The JSON
// Schemas enforce the item/property/string-length bounds that are expressible
// there; the codec layer enforces the byte/depth bounds before parsing; the
// semantic validator re-checks the security-relevant limits after parsing.
//
// Pinned decision (#283): the Phase-2 WorkspaceRepository is IndexedDB-backed,
// so `maxDecodedJsonBytes` stays at 10 MiB exactly as specced in #280 rather
// than shrinking to a localStorage-sized quota.

export const PORTABLE_LIMITS = {
  maxDecodedJsonBytes: 10 * 1024 * 1024,
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
