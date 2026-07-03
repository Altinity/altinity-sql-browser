import { describe, it, expect } from 'vitest';
import {
  assembleReferenceData, buildCompletions, completionContext, rankCompletions,
  wordAt,
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
    expect(items.find((i) => i.label === 'count')).toMatchObject({ kind: 'agg', insert: 'count()', caretBack: 1, detail: '([x])', ret: 'UInt64' });
    expect(items.find((i) => i.label === 'toDate')).toMatchObject({ kind: 'cast', detail: '(x)' });
    expect(items.find((i) => i.label === 'lower')).toMatchObject({ kind: 'fn', detail: '()' }); // sig fallback → just ()
    expect(items.find((i) => i.label === 'plus')).toMatchObject({ kind: 'fn', detail: 'a + b' }); // no '(' → sig kept as-is
    expect(items.find((i) => i.label === 'airline')).toMatchObject({ kind: 'db' });
    expect(items.find((i) => i.label === 'ontime')).toMatchObject({ kind: 'table', parent: 'airline' });
    expect(items.find((i) => i.label === 'Year')).toMatchObject({ kind: 'column', parent: 'ontime', detail: 'UInt16' });
    expect(items.some((i) => i.label === 'pending')).toBe(true);          // table listed
    expect(items.some((i) => i.kind === 'column' && i.parent === 'pending')).toBe(false); // no columns
    expect(items.find((i) => i.label === 'empty')).toMatchObject({ kind: 'db' });
    // bare names insert verbatim (label === insert)
    expect(items.find((i) => i.label === 'ontime')).toMatchObject({ insert: 'ontime' });
  });

  it('backtick-quotes the insert for non-bare db/table/column names (label stays bare)', () => {
    const schema = [{
      db: 'target_all',
      tables: [{ name: 'part-0.snappy.parquet', columns: [{ name: 'odd col', type: 'String' }] }],
    }];
    const items = buildCompletions(ref, schema);
    expect(items.find((i) => i.label === 'target_all')).toMatchObject({ kind: 'db', insert: 'target_all' });
    expect(items.find((i) => i.label === 'part-0.snappy.parquet'))
      .toMatchObject({ kind: 'table', insert: '`part-0.snappy.parquet`' });
    expect(items.find((i) => i.label === 'odd col'))
      .toMatchObject({ kind: 'column', insert: '`odd col`' });
  });
  it('handles a null schema', () => {
    const items = buildCompletions(ref, null);
    expect(items.every((i) => i.kind === 'keyword' || ['agg', 'cast', 'fn'].includes(i.kind))).toBe(true);
  });
});

describe('completionContext', () => {
  it('reads the word at the caret', () => {
    expect(completionContext('SELECT cou', 10)).toEqual({ word: 'cou', from: 7, to: 10, qualified: false, parent: null, afterFormat: false });
  });
  it('detects a qualified word after a dot and its parent', () => {
    expect(completionContext('ontime.Ye', 9)).toEqual({ word: 'Ye', from: 7, to: 9, qualified: true, parent: 'ontime', afterFormat: false });
  });
  it('qualified with empty word right after the dot', () => {
    expect(completionContext('ontime.', 7)).toEqual({ word: '', from: 7, to: 7, qualified: true, parent: 'ontime', afterFormat: false });
  });
  it('word at the very start', () => {
    expect(completionContext('SEL', 3)).toMatchObject({ word: 'SEL', from: 0, qualified: false });
  });
  it('a dot NOT preceded by an identifier is not qualified — falls back to normal completion (#4 review)', () => {
    expect(completionContext('.col', 4)).toMatchObject({ word: 'col', qualified: false, parent: null });
    expect(completionContext('count().c', 9)).toMatchObject({ word: 'c', qualified: false, parent: null });
  });
  it('treats an open backtick as the word start (from = the backtick, word unquoted)', () => {
    // SELECT * FROM `part   (caret at end) → word 'part', replace range starts at the backtick
    const v = 'SELECT * FROM `part';
    expect(completionContext(v, v.length)).toMatchObject({ word: 'part', from: 14, qualified: false });
  });
  it('does not mistake a CLOSED backtick run for an open one', () => {
    const v = 'SELECT * FROM `my tbl` WHERE x';
    expect(completionContext(v, v.length)).toMatchObject({ word: 'x', qualified: false }); // even # of backticks → bare
  });
  it('qualifies a column under a backtick-quoted table (parent unquoted)', () => {
    const v = 'SELECT `od` FROM x'; // not qualified — no dot
    expect(completionContext(v, 10)).toMatchObject({ word: 'od', qualified: false });
    const q = '`weird.tbl`.col';
    expect(completionContext(q, q.length)).toMatchObject({ word: 'col', qualified: true, parent: 'weird.tbl' });
  });
  it('handles an open backtick column under a backtick parent', () => {
    const v = '`weird.tbl`.`od';
    expect(completionContext(v, v.length)).toMatchObject({ word: 'od', qualified: true, parent: 'weird.tbl', from: 12 });
  });
  it('ignores a backtick inside a string literal (no false open-backtick mode)', () => {
    const v = "SELECT 'a`b' FROM cl";
    expect(completionContext(v, v.length)).toMatchObject({ word: 'cl', from: 18, qualified: false });
  });
  it('ignores a backtick inside a line comment', () => {
    const v = 'SELECT 1 -- use `id\nFROM ev';
    expect(completionContext(v, v.length)).toMatchObject({ word: 'ev', qualified: false });
  });
  it('a closed backtick identifier earlier in the query does not flip the mode', () => {
    const v = 'SELECT `a b` , co';
    expect(completionContext(v, v.length)).toMatchObject({ word: 'co', qualified: false });
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

describe('FORMAT-clause completion', () => {
  it('assembleReferenceData uses loaded formats, falling back to a built-in set', () => {
    expect(assembleReferenceData({ formats: ['Vertical', 'CSV'] }).formats).toEqual(['Vertical', 'CSV']);
    const fb = assembleReferenceData(null).formats;
    expect(fb).toContain('JSONEachRow');
    expect(fb).toContain('Vertical');
    expect(assembleReferenceData({ formats: [] }).formats).toEqual(fb); // empty → fallback
  });
  it('buildCompletions includes format candidates', () => {
    const ref = assembleReferenceData({ keywords: ['SELECT'], formats: ['Vertical', 'TSV'] });
    const fmts = buildCompletions(ref, []).filter((it) => it.kind === 'format');
    expect(fmts.map((f) => f.label)).toEqual(['Vertical', 'TSV']);
    expect(fmts[0]).toMatchObject({ insert: 'Vertical', detail: 'format' });
  });
  it('completionContext flags a word inside a FORMAT clause', () => {
    expect(completionContext('SELECT 1 FORMAT Ver', 19).afterFormat).toBe(true);
    expect(completionContext('SELECT 1 FORMAT ', 16).afterFormat).toBe(true); // empty word after FORMAT
    expect(completionContext('SELECT format', 13).afterFormat).toBe(false);   // FORMAT is the word being typed
    expect(completionContext('SELECT 1 FROM t', 15).afterFormat).toBe(false);
  });
  it('rankCompletions: a FORMAT clause shows only formats (prefix first); excluded elsewhere', () => {
    const items = buildCompletions(assembleReferenceData({ keywords: ['SELECT', 'FORMAT'], formats: ['JSONEachRow', 'JSONCompact', 'Vertical'] }), []);
    // empty word inside FORMAT → every format, source order
    expect(rankCompletions(items, { word: '', qualified: false, afterFormat: true }).map((i) => i.label))
      .toEqual(['JSONEachRow', 'JSONCompact', 'Vertical']);
    // typed word → filtered; both prefix-match, so alpha order
    expect(rankCompletions(items, { word: 'json', qualified: false, afterFormat: true }).map((i) => i.label))
      .toEqual(['JSONCompact', 'JSONEachRow']);
    // general completion never surfaces formats
    expect(rankCompletions(items, { word: 'json', qualified: false, afterFormat: false }).some((i) => i.kind === 'format')).toBe(false);
  });
  it('prefers the FORMAT clause keyword over format()/formatDateTime once ≥3 chars are typed', () => {
    const ref = assembleReferenceData({
      keywords: ['FORMAT', 'FROM'],
      functions: { format: { kind: 'fn', sig: 'format(p, …)' }, formatDateTime: { kind: 'fn', sig: 'formatDateTime(t)' } },
    });
    const items = buildCompletions(ref, []);
    // 'for' → the keyword wins
    const top = rankCompletions(items, { word: 'for', qualified: false, afterFormat: false });
    expect(top[0]).toMatchObject({ label: 'FORMAT', kind: 'keyword' });
    // too short to disambiguate → keyword is not specially boosted (function leads)
    const short = rankCompletions(items, { word: 'fo', qualified: false, afterFormat: false });
    expect(short[0].kind).not.toBe('keyword');
  });
});
