import { describe, it, expect } from 'vitest';
import { parseMarkdown, safeLinkHref } from '../../src/core/markdown-lite.js';

const text = (s) => ({ t: 'text', text: s });

describe('safeLinkHref', () => {
  it('allows only http(s), case-insensitively', () => {
    expect(safeLinkHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeLinkHref('HTTP://example.com')).toBe('HTTP://example.com');
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,x')).toBeNull();
    expect(safeLinkHref('//example.com')).toBeNull();
  });
});

describe('parseMarkdown — blocks', () => {
  it('empty/null input → []', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown('   \n\n  ')).toEqual([]);
  });
  it('headings 1–6; 7+ hashes are a paragraph', () => {
    expect(parseMarkdown('# Title')).toEqual([{ t: 'h', level: 1, children: [text('Title')] }]);
    expect(parseMarkdown('###### Deep')).toEqual([{ t: 'h', level: 6, children: [text('Deep')] }]);
    expect(parseMarkdown('####### Not')[0].t).toBe('p');
  });
  it('consecutive plain lines merge into one paragraph; blank lines split blocks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { t: 'p', children: [text('one two')] },
      { t: 'p', children: [text('three')] },
    ]);
  });
  it('handles CRLF input', () => {
    expect(parseMarkdown('# A\r\nbody\r\n')).toEqual([
      { t: 'h', level: 1, children: [text('A')] },
      { t: 'p', children: [text('body')] },
    ]);
  });
  it('unordered lists group -/* items; ordered lists group 1. items', () => {
    expect(parseMarkdown('- a\n* b')).toEqual([{ t: 'ul', items: [[text('a')], [text('b')]] }]);
    expect(parseMarkdown('1. a\n2. b')).toEqual([{ t: 'ol', items: [[text('a')], [text('b')]] }]);
  });
  it('a list-type switch starts a new list; a paragraph between lists splits them', () => {
    expect(parseMarkdown('- a\n1. b').map((b) => b.t)).toEqual(['ul', 'ol']);
    expect(parseMarkdown('- a\n\npara\n\n- b').map((b) => b.t)).toEqual(['ul', 'p', 'ul']);
  });
  it('a heading terminates a pending paragraph', () => {
    expect(parseMarkdown('body\n# H').map((b) => b.t)).toEqual(['p', 'h']);
    expect(parseMarkdown('body\n- item').map((b) => b.t)).toEqual(['p', 'ul']);
  });
});

describe('parseMarkdown — inline', () => {
  const inline = (s) => parseMarkdown(s)[0].children;
  it('bold, italic (both markers), inline code, with surrounding text', () => {
    expect(inline('a **b** c')).toEqual([text('a '), { t: 'strong', children: [text('b')] }, text(' c')]);
    expect(inline('*i*')).toEqual([{ t: 'em', children: [text('i')] }]);
    expect(inline('_i_')).toEqual([{ t: 'em', children: [text('i')] }]);
    expect(inline('x `code` y')).toEqual([text('x '), { t: 'code', text: 'code' }, text(' y')]);
  });
  it('bold may nest italic; code suppresses markup inside', () => {
    expect(inline('**a *b***')).toEqual([
      { t: 'strong', children: [text('a '), { t: 'em', children: [text('b')] }] },
    ]);
    expect(inline('`**not bold**`')).toEqual([{ t: 'code', text: '**not bold**' }]);
  });
  it('links keep http(s) hrefs; unsafe schemes render as plain text (no link node)', () => {
    expect(inline('see [docs](https://ch.example/d)')).toEqual([
      text('see '),
      { t: 'link', href: 'https://ch.example/d', children: [text('docs')] },
    ]);
    // The whole construct stays literal — visibly not a link, nothing to click.
    expect(inline('[x](javascript:void0)')).toEqual([text('[x](javascript:void0)')]);
    expect(inline('[x](data:text/html,y)')).toEqual([text('[x](data:text/html,y)')]);
  });
  it('raw HTML is literal text — the parser never interprets tags', () => {
    expect(inline('<script>alert(1)</script>')).toEqual([text('<script>alert(1)</script>')]);
    expect(inline('<img src=x onerror=alert(1)>')).toEqual([text('<img src=x onerror=alert(1)>')]);
  });
  it('inline formatting works inside headings and list items', () => {
    expect(parseMarkdown('# a **b**')[0].children[1].t).toBe('strong');
    expect(parseMarkdown('- has `code`')[0].items[0][1]).toEqual({ t: 'code', text: 'code' });
  });
});
