import { describe, it, expect } from 'vitest';
import { looksLikeHtml, looksLikeMarkdown, prettyValue } from '../../src/core/cell.js';

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

describe('looksLikeMarkdown', () => {
  it('true for each block-level signal', () => {
    expect(looksLikeMarkdown('# Heading')).toBe(true);
    expect(looksLikeMarkdown('## Sub heading')).toBe(true);
    expect(looksLikeMarkdown('- item\n- item')).toBe(true);
    expect(looksLikeMarkdown('* bullet')).toBe(true);
    expect(looksLikeMarkdown('1. first\n2. second')).toBe(true);
    expect(looksLikeMarkdown('3) alt ordered')).toBe(true);
    expect(looksLikeMarkdown('> a quote')).toBe(true);
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('intro\n~~~\ncode\n~~~')).toBe(true);
    expect(looksLikeMarkdown('---')).toBe(true);
    expect(looksLikeMarkdown('***')).toBe(true);
    expect(looksLikeMarkdown('see [the docs](https://example.com) now')).toBe(true);
    expect(looksLikeMarkdown('a heading below\n### Details')).toBe(true); // not only at line 0
  });
  it('false for plain prose, ambiguous emphasis, empty, and null', () => {
    expect(looksLikeMarkdown('just a normal sentence.')).toBe(false);
    expect(looksLikeMarkdown('use the *args and **kwargs identifiers')).toBe(false); // lone emphasis ignored
    expect(looksLikeMarkdown('a-b-c hyphenated')).toBe(false);
    expect(looksLikeMarkdown('1.5 is a number, not a list')).toBe(false);
    expect(looksLikeMarkdown('#nospace is not a heading')).toBe(false);
    expect(looksLikeMarkdown('   ')).toBe(false);
    expect(looksLikeMarkdown('')).toBe(false);
    expect(looksLikeMarkdown(null)).toBe(false);
    expect(looksLikeMarkdown(undefined)).toBe(false);
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
