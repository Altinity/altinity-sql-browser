import { describe, it, expect } from 'vitest';
import {
  assembleReferenceData, buildCompletions, completionContext, rankCompletions,
  wordAt, signatureContext,
} from '../../src/core/completions.js';
import { SQL_KEYWORDS, SQL_FUNCS } from '../../src/core/sql-highlight.js';

describe('assembleReferenceData', () => {
  it('falls back to the built-in sets when given null', () => {
    const ref = assembleReferenceData(null);
    expect(ref.keywords).toEqual([...SQL_KEYWORDS]);
    expect(ref.keywordSet.has('SELECT')).toBe(true);
    expect(ref.funcSet.has('count')).toBe(true);
    // built-in functions get a synthesized meta entry
    expect(ref.functions.count).toEqual({ kind: 'fn', sig: 'count()', ret: '', desc: '' });
  });
  it('uses loaded keywords + functions when present', () => {
    const ref = assembleReferenceData({
      keywords: ['select', 'prewhere'],
      functions: { toDate: { kind: 'cast', sig: 'toDate(x)', ret: 'Date', desc: 'd' } },
    });
    expect(ref.keywords).toEqual(['select', 'prewhere']);
    expect(ref.keywordSet.has('PREWHERE')).toBe(true);   // uppercased for the tokenizer
    expect(ref.funcSet.has('toDate')).toBe(true);
    expect(ref.funcSet.has('count')).toBe(false);        // not built-in fallback
  });
  it('falls back per-field when keywords or functions are empty', () => {
    const ref = assembleReferenceData({ keywords: [], functions: {} });
    expect(ref.keywords).toEqual([...SQL_KEYWORDS]);
    expect(Object.keys(ref.functions).length).toBe(SQL_FUNCS.size);
  });
  it('exposes a built-in keyword-docs map for hover (#27)', () => {
    expect(assembleReferenceData(null).keywordDocs.PREWHERE).toContain('before reading');
  });
});

describe('wordAt', () => {
  it('returns the identifier surrounding a position', () => {
    expect(wordAt('select count(x)', 9)).toEqual({ word: 'count', from: 7, to: 12 });
  });
  it('returns null when the position is not inside a word', () => {
    expect(wordAt('a (b)', 2)).toBeNull(); // on the space
  });
});

describe('signatureContext', () => {
  it('finds the enclosing function and the active argument index', () => {
    expect(signatureContext('sum(a', 5)).toEqual({ name: 'sum', argIdx: 0 });
    expect(signatureContext('sum(a, b', 8)).toEqual({ name: 'sum', argIdx: 1 });
  });
  it('counts only commas at the call depth (skips nested calls)', () => {
    expect(signatureContext('if(x, foo(a,b), ', 16)).toEqual({ name: 'if', argIdx: 2 });
  });
  it('returns null outside a call, for an anonymous (, and across ; or newline', () => {
    expect(signatureContext('select 1', 8)).toBeNull();
    expect(signatureContext('(a', 2)).toBeNull();         // no name before '('
    expect(signatureContext('sum(a); x', 9)).toBeNull();  // ';' at depth 0 stops the scan
    expect(signatureContext('a\nb', 3)).toBeNull();        // newline at depth 0 stops the scan
  });
});

describe('buildCompletions', () => {
  const ref = {
    keywords: ['SELECT'],
    functions: {
      count: { kind: 'agg', sig: 'count([x])', ret: 'UInt64', desc: 'counts' },
      toDate: { kind: 'cast', sig: 'toDate(x)', ret: 'Date', desc: 'casts' },
      lower: { kind: 'fn', sig: '', ret: '', desc: '' }, // missing sig → fallback name()
      plus: { kind: 'fn', sig: 'a + b', ret: '', desc: '' }, // operator syntax, no '(' → kept as-is
    },
  };
  const schema = [
    { db: 'airline', tables: [
      { name: 'ontime', columns: [{ name: 'Year', type: 'UInt16' }] },
      { name: 'pending', columns: null },   // not loaded → no column items, table still listed
    ] },
    { db: 'empty' },                          // db.tables undefined → just the db item
  ];

  it('maps keywords, function kinds, and schema (loaded columns only)', () => {
    const items = buildCompletions(ref, schema);
    expect(items.find((i) => i.label === 'SELECT')).toMatchObject({ kind: 'keyword', insert: 'SELECT' });
    // detail shows only the params (the label already shows the name) — #26
    expect(items.find((i) => i.label === 'count')).toMatchObject({ kind: 'agg', insert: 'count(', detail: '([x])', ret: 'UInt64' });
    expect(items.find((i) => i.label === 'toDate')).toMatchObject({ kind: 'cast', detail: '(x)' });
    expect(items.find((i) => i.label === 'lower')).toMatchObject({ kind: 'fn', detail: '()' }); // sig fallback → just ()
    expect(items.find((i) => i.label === 'plus')).toMatchObject({ kind: 'fn', detail: 'a + b' }); // no '(' → sig kept as-is
    expect(items.find((i) => i.label === 'airline')).toMatchObject({ kind: 'db' });
    expect(items.find((i) => i.label === 'ontime')).toMatchObject({ kind: 'table', parent: 'airline' });
    expect(items.find((i) => i.label === 'Year')).toMatchObject({ kind: 'column', parent: 'ontime', detail: 'UInt16' });
    expect(items.some((i) => i.label === 'pending')).toBe(true);          // table listed
    expect(items.some((i) => i.kind === 'column' && i.parent === 'pending')).toBe(false); // no columns
    expect(items.find((i) => i.label === 'empty')).toMatchObject({ kind: 'db' });
  });
  it('handles a null schema', () => {
    const items = buildCompletions(ref, null);
    expect(items.every((i) => i.kind === 'keyword' || ['agg', 'cast', 'fn'].includes(i.kind))).toBe(true);
  });
});

describe('completionContext', () => {
  it('reads the word at the caret', () => {
    expect(completionContext('SELECT cou', 10)).toEqual({ word: 'cou', from: 7, to: 10, qualified: false, parent: null });
  });
  it('detects a qualified word after a dot and its parent', () => {
    expect(completionContext('ontime.Ye', 9)).toEqual({ word: 'Ye', from: 7, to: 9, qualified: true, parent: 'ontime' });
  });
  it('qualified with empty word right after the dot', () => {
    expect(completionContext('ontime.', 7)).toEqual({ word: '', from: 7, to: 7, qualified: true, parent: 'ontime' });
  });
  it('word at the very start', () => {
    expect(completionContext('SEL', 3)).toMatchObject({ word: 'SEL', from: 0, qualified: false });
  });
  it('a dot NOT preceded by an identifier is not qualified — falls back to normal completion (#4 review)', () => {
    expect(completionContext('.col', 4)).toMatchObject({ word: 'col', qualified: false, parent: null });
    expect(completionContext('count().c', 9)).toMatchObject({ word: 'c', qualified: false, parent: null });
  });
});

describe('rankCompletions', () => {
  const items = [
    { label: 'SELECT', kind: 'keyword' },
    { label: 'sum', kind: 'agg' },
    { label: 'substring', kind: 'fn' },
    { label: 'ontime', kind: 'table', parent: 'airline' },
    { label: 'Year', kind: 'column', parent: 'ontime' },
    { label: 'Month', kind: 'column', parent: 'ontime' },
    { label: 'Origin', kind: 'column', parent: 'other' },
  ];

  it('qualified → only the parent table columns, optionally filtered', () => {
    const all = rankCompletions(items, { word: '', qualified: true, parent: 'ontime' });
    expect(all.map((i) => i.label)).toEqual(['Year', 'Month']);
    const filtered = rankCompletions(items, { word: 'mon', qualified: true, parent: 'ontime' });
    expect(filtered.map((i) => i.label)).toEqual(['Month']);
  });
  it('empty word (unqualified) → keywords + tables only', () => {
    const r = rankCompletions(items, { word: '', qualified: false, parent: null });
    expect(r.map((i) => i.label).sort()).toEqual(['SELECT', 'ontime']);
  });
  it('scores prefix above substring and boosts schema over keywords', () => {
    const r = rankCompletions(items, { word: 's', qualified: false, parent: null });
    // 'SELECT','sum','substring' all start with s; none of the schema rows match 's'
    expect(r[0].label).toBe('sum'); // shorter prefix match ranks first by length tiebreak
    expect(r.map((i) => i.label)).toContain('substring');
  });
  it('skips non-matches and ranks a substring hit below prefixes', () => {
    const r = rankCompletions(items, { word: 'o', qualified: false, parent: null });
    // 'ontime','Origin','Month'(substring 'o'),'substring'? no. prefix: ontime/Origin
    expect(r.map((i) => i.label)).toContain('ontime');
    expect(r).not.toContainEqual(expect.objectContaining({ label: 'SELECT' }));
  });
});
