import { describe, it, expect } from 'vitest';
import {
  newResult, applyStreamLine, splitBuffer, parseExceptionText, isAuthExpiredBody,
  authDeniedMessage, parseErrorPos,
} from '../../src/core/stream.js';

describe('newResult', () => {
  it('creates an empty result carrying the format', () => {
    const r = newResult('TSV');
    expect(r).toMatchObject({ columns: [], rows: [], rawText: null, rawFormat: 'TSV', error: null, pct: 0 });
    expect(r.progress).toEqual({ rows: 0, bytes: 0, elapsed_ns: 0 });
  });
  it('defaults to an uncapped row limit', () => {
    expect(newResult('Table')).toMatchObject({ rowLimit: 0, capped: false });
  });
  it('carries the row limit when given', () => {
    expect(newResult('Table', 500)).toMatchObject({ rowLimit: 500, capped: false });
  });
});

describe('applyStreamLine', () => {
  it('sets columns from meta', () => {
    const r = newResult('Table');
    applyStreamLine({ meta: [{ name: 'a', type: 'UInt8' }, { name: 'b', type: 'String' }] }, r);
    expect(r.columns).toEqual([{ name: 'a', type: 'UInt8' }, { name: 'b', type: 'String' }]);
  });
  it('pushes rows in column order', () => {
    const r = newResult('Table');
    applyStreamLine({ meta: [{ name: 'a', type: 'UInt8' }, { name: 'b', type: 'String' }] }, r);
    applyStreamLine({ row: { a: '1', b: 'x' } }, r);
    expect(r.rows).toEqual([['1', 'x']]);
  });
  it('accumulates progress and pct', () => {
    const r = newResult('Table');
    applyStreamLine({ progress: { read_rows: '50', read_bytes: '500', elapsed_ns: '1000', total_rows_to_read: '100' } }, r);
    expect(r.progress).toEqual({ rows: 50, bytes: 500, elapsed_ns: 1000, total_rows: 100 });
    expect(r.pct).toBe(50);
  });
  it('pct is 0 when total unknown, capped at 100', () => {
    const r = newResult('Table');
    applyStreamLine({ progress: { read_rows: '5' } }, r);
    expect(r.pct).toBe(0);
    applyStreamLine({ progress: { read_rows: '200', total_rows_to_read: '100' } }, r);
    expect(r.pct).toBe(100);
  });
  it('all progress fields fall back to 0 when absent', () => {
    const r = newResult('Table');
    applyStreamLine({ progress: {} }, r);
    expect(r.progress).toEqual({ rows: 0, bytes: 0, elapsed_ns: 0, total_rows: 0 });
    expect(r.pct).toBe(0);
  });
  it('stops pushing rows at the cap and flags capped (trims block-boundary overage)', () => {
    const r = newResult('Table', 2);
    applyStreamLine({ meta: [{ name: 'a', type: 'UInt8' }] }, r);
    applyStreamLine({ row: { a: '1' } }, r);
    applyStreamLine({ row: { a: '2' } }, r);
    expect(r.capped).toBe(false);
    applyStreamLine({ row: { a: '3' } }, r); // overage past the cap → dropped + flagged
    applyStreamLine({ row: { a: '4' } }, r);
    expect(r.rows).toEqual([['1'], ['2']]);
    expect(r.capped).toBe(true);
  });
  it('captures exceptions', () => {
    const r = newResult('Table');
    applyStreamLine({ exception: 'boom' }, r);
    expect(r.error).toBe('boom');
  });
  it('ignores unrecognized lines', () => {
    const r = newResult('Table');
    const before = JSON.stringify(r);
    applyStreamLine({ something: 1 }, r);
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe('splitBuffer', () => {
  it('returns complete lines and the trailing remainder', () => {
    const { lines, rest } = splitBuffer('a\nb\npar');
    expect(lines).toEqual(['a', 'b']);
    expect(rest).toBe('par');
  });
  it('drops empty lines', () => {
    const { lines, rest } = splitBuffer('a\n\nb\n');
    expect(lines).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });
});

describe('parseExceptionText', () => {
  it('extracts the exception line', () => {
    expect(parseExceptionText('{"meta":1}\n{"exception":"DB::Exception: nope"}')).toBe('DB::Exception: nope');
  });
  it('falls back to raw text when no exception line', () => {
    expect(parseExceptionText('plain error')).toBe('plain error');
  });
  it('falls back to raw text when the exception line is malformed JSON', () => {
    expect(parseExceptionText('{"exception": bad')).toBe('{"exception": bad');
  });
});

describe('parseErrorPos', () => {
  it('returns the 0-based caret offset from "position N" (1-based in the message)', () => {
    expect(parseErrorPos('Syntax error: failed at position 18 (BEWEEN): …')).toBe(17);
    expect(parseErrorPos('failed at position 1 (x)')).toBe(0);
  });
  it('returns null when no position is present', () => {
    expect(parseErrorPos('Some other DB::Exception')).toBeNull();
    expect(parseErrorPos('')).toBeNull();
    expect(parseErrorPos(null)).toBeNull();
  });
});

describe('isAuthExpiredBody', () => {
  it('detects token verification failures', () => {
    expect(isAuthExpiredBody('... token_verification_exception ...')).toBe(true);
    expect(isAuthExpiredBody('Token Expired')).toBe(true);
    expect(isAuthExpiredBody('syntax error')).toBe(false);
  });
});

describe('authDeniedMessage', () => {
  it('interpolates the status and appends a collapsed server reason', () => {
    const m = authDeniedMessage(403, '  Code: 516.\n DB::Exception: Authentication failed  ');
    expect(m).toContain('HTTP 403');
    expect(m).toContain('not authorizing you');
    expect(m).toContain('Server: Code: 516. DB::Exception: Authentication failed');
    expect(m).not.toContain('\n');
  });
  it('omits the Server tail when there is no reason', () => {
    const m = authDeniedMessage(401, '');
    expect(m).toContain('HTTP 401');
    expect(m).not.toContain('Server:');
    expect(authDeniedMessage(401, '   ')).toBe(m); // whitespace-only is treated as empty
    expect(authDeniedMessage(401)).toBe(m); // undefined reason
  });
});
