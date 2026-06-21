import { describe, it, expect } from 'vitest';
import { looksLikeHtml, prettyValue } from '../../src/core/cell.js';

describe('looksLikeHtml', () => {
  it('true for tag pairs and self-closing tags', () => {
    expect(looksLikeHtml('<div>hi</div>')).toBe(true);
    expect(looksLikeHtml('<p>a</p><br/>')).toBe(true);
    expect(looksLikeHtml('<img src="x"/>')).toBe(true);
  });
  it('false for a lone open tag, plain text, comparisons, and empty', () => {
    expect(looksLikeHtml('<img src=x>')).toBe(false); // no close / self-close
    expect(looksLikeHtml('just text')).toBe(false);
    expect(looksLikeHtml('a < b and c > d')).toBe(false);
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml(null)).toBe(false);
  });
});

describe('prettyValue', () => {
  it('reindents valid JSON objects and arrays', () => {
    expect(prettyValue('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyValue('[1,2]')).toBe('[\n  1,\n  2\n]');
  });
  it('returns non-JSON as-is, coerces non-strings, and maps null/undefined to ""', () => {
    expect(prettyValue('plain text')).toBe('plain text');
    expect(prettyValue('{not json')).toBe('{not json'); // starts with { but invalid → catch
    expect(prettyValue(123)).toBe('123');
    expect(prettyValue(null)).toBe('');
    expect(prettyValue(undefined)).toBe('');
  });
});
