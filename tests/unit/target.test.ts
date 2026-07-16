import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../../src/core/target.js';

const ORIGIN = 'https://serving.example';

describe('resolveTarget', () => {
  it('blank input → the serving origin (same-origin)', () => {
    expect(resolveTarget('', ORIGIN)).toBe(ORIGIN);
    expect(resolveTarget('   ', ORIGIN)).toBe(ORIGIN);
    expect(resolveTarget(null, ORIGIN)).toBe(ORIGIN);
    expect(resolveTarget(undefined, ORIGIN)).toBe(ORIGIN);
  });
  it('bare host → https + default :8443', () => {
    expect(resolveTarget('ch.example', ORIGIN)).toBe('https://ch.example:8443');
  });
  it('host:port → https, explicit port kept', () => {
    expect(resolveTarget('ch.example:9000', ORIGIN)).toBe('https://ch.example:9000');
  });
  it('explicit scheme is honoured (and no default port added)', () => {
    expect(resolveTarget('http://ch.example:8123', ORIGIN)).toBe('http://ch.example:8123');
    expect(resolveTarget('https://ch.example', ORIGIN)).toBe('https://ch.example');
  });
  it('trims surrounding whitespace before parsing', () => {
    expect(resolveTarget('  ch.example:9000  ', ORIGIN)).toBe('https://ch.example:9000');
  });
  it('strips any path/query, returning just the origin', () => {
    expect(resolveTarget('ch.example:9000/foo?x=1', ORIGIN)).toBe('https://ch.example:9000');
  });
  it('unparseable input falls back to the serving origin', () => {
    expect(resolveTarget('::::', ORIGIN)).toBe(ORIGIN);
  });
});
