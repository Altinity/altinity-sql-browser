import { describe, it, expect } from 'vitest';
import { SQL_KEYWORDS, SQL_FUNCS } from '../../src/core/sql-reference.js';

// These are the offline fallback reference sets (relocated verbatim from the
// deleted highlighter). Their membership backs completion fallbacks and the
// from-scope implicit-alias stop set, so lock a representative sample.
describe('sql-reference fallback sets', () => {
  it('SQL_KEYWORDS holds uppercased SQL keywords', () => {
    expect(SQL_KEYWORDS).toBeInstanceOf(Set);
    for (const k of ['SELECT', 'FROM', 'WHERE', 'JOIN', 'PREWHERE', 'FINAL', 'SETTINGS', 'FORMAT']) {
      expect(SQL_KEYWORDS.has(k)).toBe(true);
    }
    expect(SQL_KEYWORDS.has('select')).toBe(false); // stored uppercased
  });

  it('SQL_FUNCS holds case-exact ClickHouse function names', () => {
    expect(SQL_FUNCS).toBeInstanceOf(Set);
    for (const f of ['count', 'toDateTime', 'arrayJoin', 'quantiles']) {
      expect(SQL_FUNCS.has(f)).toBe(true);
    }
    expect(SQL_FUNCS.has('COUNT')).toBe(false); // case-exact
  });
});
