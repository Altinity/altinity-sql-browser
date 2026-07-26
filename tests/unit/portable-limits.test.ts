import { describe, expect, it } from 'vitest';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';

describe('PORTABLE_LIMITS', () => {
  it('pins every #280 v1 limit verbatim', () => {
    expect(PORTABLE_LIMITS).toEqual({
      maxDecodedJsonBytes: 20971520,
      maxJsonDepth: 64,
      maxQueries: 5224,
      maxDashboards: 32,
      maxTilesPerDashboard: 100,
      maxLayoutItemsPerDashboard: 100,
      maxVariantsPerQuery: 32,
      maxIdLength: 256,
      maxNameLength: 512,
      maxTitleLength: 512,
      maxDescriptionLength: 16384,
      maxSqlLength: 1048576,
      maxSerializedQuerySpecBytes: 1048576,
      maxSerializedLayoutConfigBytes: 262144,
    });
    // Pinned decision (#283): the Phase-2 repository is IndexedDB-backed, so
    // the decoded-JSON cap stays at 10 MiB exactly as specced in #280.
    expect(PORTABLE_LIMITS.maxDecodedJsonBytes).toBe(20 * 1024 * 1024);
    // #447 deleted `maxFiltersPerDashboard`/`maxSerializedFilterDefaultBytes` (a
    // Dashboard has no persisted filters left to bound) but deliberately did NOT
    // lower `maxQueries` to the newly-derived 1000 + 32 x 100 = 4200: 5224 is now
    // a COMPATIBILITY CEILING for records that already migrated under #427, and
    // tightening it would fail their validation on open with no repair path.
    expect(PORTABLE_LIMITS.maxQueries).toBe(5224);
    expect(PORTABLE_LIMITS).not.toHaveProperty('maxFiltersPerDashboard');
    expect(PORTABLE_LIMITS).not.toHaveProperty('maxSerializedFilterDefaultBytes');
  });
});
