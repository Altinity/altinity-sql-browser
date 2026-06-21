import { describe, it, expect } from 'vitest';
import {
  clamp, formatRows, formatBytes, timeAgo, sqlString, inferQueryName, isNumericType, shortVersion,
} from '../../src/core/format.js';

describe('clamp', () => {
  it('clamps below, within, above', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('formatRows', () => {
  it('handles null / NaN', () => {
    expect(formatRows(null)).toBe('—');
    expect(formatRows(undefined)).toBe('—');
    expect(formatRows('abc')).toBe('—');
  });
  it('formats each band', () => {
    expect(formatRows(0)).toBe('0');
    expect(formatRows(999)).toBe('999');
    expect(formatRows(1500)).toBe('1.5K');
    expect(formatRows(20000)).toBe('20K');
    expect(formatRows(1.5e6)).toBe('1.5M');
    expect(formatRows(2e7)).toBe('20M');
    expect(formatRows(1.5e9)).toBe('1.5B');
    expect(formatRows(2e10)).toBe('20B');
  });
});

describe('formatBytes', () => {
  it('handles null / NaN', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes('x')).toBe('—');
  });
  it('formats each unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.00 TB');
  });
});

describe('timeAgo', () => {
  const now = 1_000_000_000_000;
  it('renders seconds/minutes/hours/days', () => {
    expect(timeAgo(now - 5_000, now)).toBe('5s ago');
    expect(timeAgo(now - 120_000, now)).toBe('2m ago');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86400_000, now)).toBe('2d ago');
  });
  it('defaults now to Date.now()', () => {
    expect(timeAgo(Date.now())).toBe('0s ago');
  });
});

describe('sqlString', () => {
  it('quotes and doubles single quotes', () => {
    expect(sqlString('abc')).toBe("'abc'");
    expect(sqlString("a'b")).toBe("'a''b'");
    expect(sqlString(42)).toBe("'42'");
  });
  it('escapes backslashes so a trailing one cannot break out of the literal', () => {
    expect(sqlString('a\\b')).toBe("'a\\\\b'");
    expect(sqlString('x\\')).toBe("'x\\\\'");
    expect(sqlString("\\'")).toBe("'\\\\'''");
  });
});

describe('inferQueryName', () => {
  it('uses FROM table when present', () => {
    expect(inferQueryName('SELECT * FROM system.tables')).toBe('Query · system.tables');
    expect(inferQueryName('select a from db.t')).toBe('Query · db.t');
  });
  it('strips quote chars that follow an unquoted leading identifier', () => {
    // The matcher anchors on a letter/underscore, then strips backticks/quotes
    // from the captured tail.
    expect(inferQueryName('SELECT 1 FROM t`x`')).toBe('Query · tx');
  });
  it('falls back to short SQL', () => {
    expect(inferQueryName('SELECT 1')).toBe('SELECT 1');
  });
  it('truncates long SQL without FROM', () => {
    const long = 'SELECT ' + 'x'.repeat(80);
    const name = inferQueryName(long);
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBe(46);
  });
});

describe('isNumericType', () => {
  it('detects numeric CH types', () => {
    expect(isNumericType('UInt64')).toBe(true);
    expect(isNumericType('Int32')).toBe(true);
    expect(isNumericType('Float64')).toBe(true);
    expect(isNumericType('Decimal(10,2)')).toBe(true);
    expect(isNumericType('String')).toBe(false);
    expect(isNumericType('')).toBe(false);
    expect(isNumericType(null)).toBe(false);
  });
});

describe('shortVersion', () => {
  it('keeps the first three dot-segments of a long version', () => {
    expect(shortVersion('26.3.10.20001.altinityantalya')).toBe('26.3.10');
  });
  it('passes through short versions and empty/nullish input', () => {
    expect(shortVersion('26.3.1')).toBe('26.3.1');
    expect(shortVersion('26.3')).toBe('26.3');
    expect(shortVersion('')).toBe('');
    expect(shortVersion(null)).toBe('');
  });
});
