import { describe, it, expect } from 'vitest';
import {
  resolveDocTarget, lookupFunctionEntry, docTargetForMatch,
} from '../../src/core/doc-context.js';
import type { CompletionFunctionEntry } from '../../src/core/completions.js';

const FUNCTIONS: Record<string, CompletionFunctionEntry> = {
  count: { kind: 'agg', sig: 'count()', ret: 'UInt64', desc: '' },
  toDateTime: { kind: 'fn', sig: 'toDateTime(x)', ret: 'DateTime', desc: '' },
  CAST: { kind: 'cast', sig: 'CAST(x, T)', ret: '', desc: '' },
};

describe('lookupFunctionEntry', () => {
  it('matches exact case first', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'toDateTime')).toEqual({ key: 'toDateTime', entry: FUNCTIONS.toDateTime });
  });

  it('falls back to lowercase, then UPPERCASE', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'COUNT')).toEqual({ key: 'count', entry: FUNCTIONS.count });
    expect(lookupFunctionEntry(FUNCTIONS, 'cast')).toEqual({ key: 'CAST', entry: FUNCTIONS.CAST });
  });


  it('returns undefined for an unknown word', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'nope')).toBeUndefined();
  });

  it('never resolves off Object.prototype (own properties only)', () => {
    expect(lookupFunctionEntry(FUNCTIONS, 'constructor')).toBeUndefined();
    expect(lookupFunctionEntry(FUNCTIONS, 'toString')).toBeUndefined();
    expect(lookupFunctionEntry(FUNCTIONS, 'hasOwnProperty')).toBeUndefined();
  });
});

describe('docTargetForMatch', () => {
  it('maps an aggregate entry to kind aggregate-function', () => {
    expect(docTargetForMatch({ key: 'count', entry: FUNCTIONS.count })).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('maps fn/cast entries to kind function', () => {
    expect(docTargetForMatch({ key: 'toDateTime', entry: FUNCTIONS.toDateTime })).toEqual({ kind: 'function', name: 'toDateTime' });
    expect(docTargetForMatch({ key: 'CAST', entry: FUNCTIONS.CAST })).toEqual({ kind: 'function', name: 'CAST' });
  });

  it('an entry with no kind at all defaults to function', () => {
    expect(docTargetForMatch({ key: 'bare', entry: {} })).toEqual({ kind: 'function', name: 'bare' });
  });
});

describe('resolveDocTarget', () => {
  it('resolves a known function at a caret inside the word', () => {
    expect(resolveDocTarget('select toDateTime(x)', 10, FUNCTIONS)).toEqual({ kind: 'function', name: 'toDateTime' });
  });

  it('resolves a known aggregate case-insensitively', () => {
    expect(resolveDocTarget('SELECT COUNT(*)', 9, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('returns null for an unknown identifier', () => {
    expect(resolveDocTarget('select mystery(x)', 10, FUNCTIONS)).toBeNull();
  });

  it('returns null when the caret is on whitespace (no word there)', () => {
    expect(resolveDocTarget('a b', 1, FUNCTIONS)).toBeNull();
  });

  it('returns null when the caret sits between two punctuation characters (no word there)', () => {
    expect(resolveDocTarget('count(*)', 6, FUNCTIONS)).toBeNull(); // between '(' and '*'
  });

  it('returns null on an empty document', () => {
    expect(resolveDocTarget('', 0, FUNCTIONS)).toBeNull();
  });

  it('resolves at position 0 (start of the word/document)', () => {
    expect(resolveDocTarget('count(*)', 0, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('resolves at the exact end of the word (caret right after the last char)', () => {
    expect(resolveDocTarget('count', 5, FUNCTIONS)).toEqual({ kind: 'aggregate-function', name: 'count' });
  });

  it('resolves at the exact end of the whole text', () => {
    const text = 'select toDateTime';
    expect(resolveDocTarget(text, text.length, FUNCTIONS)).toEqual({ kind: 'function', name: 'toDateTime' });
  });
});
