import { describe, expect, it } from 'vitest';
import { PORTABLE_LIMITS } from '../../src/dashboard/model/portable-limits.js';

describe('PORTABLE_LIMITS', () => {
  it('pins every #280 v1 limit verbatim', () => {
    expect(PORTABLE_LIMITS).toEqual({
      maxDecodedJsonBytes: 10485760,
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
      maxDescriptionLength: 16384,
      maxSqlLength: 1048576,
      maxSerializedQuerySpecBytes: 1048576,
      maxSerializedLayoutConfigBytes: 262144,
      maxSerializedFilterDefaultBytes: 65536,
    });
    // Pinned decision (#283): the Phase-2 repository is IndexedDB-backed, so
    // the decoded-JSON cap stays at 10 MiB exactly as specced in #280.
    expect(PORTABLE_LIMITS.maxDecodedJsonBytes).toBe(10 * 1024 * 1024);
  });
});
