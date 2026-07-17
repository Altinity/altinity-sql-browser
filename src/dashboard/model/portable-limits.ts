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

  maxQueries: 1000,
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
