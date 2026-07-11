import { describe, it, expect } from 'vitest';
import {
  ALL_ACTIVE,
  countOptionalBlocks,
  hasOptionalBlocks,
  materializeOptionalBlocks,
} from '../../src/core/optional-blocks.js';

describe('countOptionalBlocks / hasOptionalBlocks', () => {
  it('counts only code-context /*[ comment candidates', () => {
    expect(countOptionalBlocks('SELECT 1')).toBe(0);
    expect(countOptionalBlocks('SELECT 1 /*[ x = {x:String} ]*/')).toBe(1);
    expect(countOptionalBlocks('/*[ a {a:UInt8} ]*/ SELECT 1 /*[ b {b:UInt8} ]*/')).toBe(2);
    expect(countOptionalBlocks('SELECT 1 /* plain comment */')).toBe(0);
    expect(countOptionalBlocks(undefined)).toBe(0);
  });
  it('counts an invalid candidate too (Format must skip broken templates)', () => {
    expect(countOptionalBlocks('SELECT 1 /*[ no closing')).toBe(1);
    expect(hasOptionalBlocks('SELECT 1 /*[ no closing')).toBe(true);
    expect(hasOptionalBlocks('SELECT 1')).toBe(false);
  });
});

describe('materializeOptionalBlocks — inclusion/removal', () => {
  const stmt = 'SELECT *\nFROM events\nWHERE 1\n/*[ AND d = {d:String} ]*/';

  it('includes the block when its parameter is active — markers stripped, content byte-identical', () => {
    const r = materializeOptionalBlocks(stmt, { d: true });
    expect(r.sql).toBe('SELECT *\nFROM events\nWHERE 1\n AND d = {d:String} ');
    expect(r.errors).toEqual([]);
    expect(r.blocks).toEqual([{
      start: stmt.indexOf('/*['), end: stmt.length, content: ' AND d = {d:String} ', params: ['d'], included: true,
    }]);
  });

  it('removes the whole block when the parameter is inactive (or has no entry)', () => {
    expect(materializeOptionalBlocks(stmt, { d: false }).sql).toBe('SELECT *\nFROM events\nWHERE 1\n');
    expect(materializeOptionalBlocks(stmt).sql).toBe('SELECT *\nFROM events\nWHERE 1\n'); // no map at all
    expect(materializeOptionalBlocks(stmt, {}).blocks[0].included).toBe(false);
  });

  it('classifies params: outside blocks required, block-only optional', () => {
    const r = materializeOptionalBlocks(stmt, {});
    expect(r.requiredParams).toEqual([]);
    expect(r.optionalParams).toEqual(['d']);
    const both = materializeOptionalBlocks(
      'SELECT {tenant:UInt64}, {tenant:UInt64} /*[ AND d = {d:String} ]*/', {});
    expect(both.requiredParams).toEqual(['tenant']); // deduped across occurrences
    expect(both.optionalParams).toEqual(['d']);
  });

  it('several independent blocks materialize independently', () => {
    const s = 'WHERE 1\n/*[ AND t >= {from:DateTime} ]*/\n/*[ AND t < {to:DateTime} ]*/';
    expect(materializeOptionalBlocks(s, { from: true }).sql)
      .toBe('WHERE 1\n AND t >= {from:DateTime} \n');
    expect(materializeOptionalBlocks(s, { to: true }).sql)
      .toBe('WHERE 1\n\n AND t < {to:DateTime} ');
    expect(materializeOptionalBlocks(s, { from: true, to: true }).sql)
      .toBe('WHERE 1\n AND t >= {from:DateTime} \n AND t < {to:DateTime} ');
  });

  it('a block referencing several params needs ALL of them active', () => {
    const s = 'WHERE 1 /*[ AND t BETWEEN {from:DateTime} AND {to:DateTime} ]*/';
    expect(materializeOptionalBlocks(s, { from: true }).sql).toBe('WHERE 1 ');
    expect(materializeOptionalBlocks(s, { from: true, to: true }).sql)
      .toBe('WHERE 1  AND t BETWEEN {from:DateTime} AND {to:DateTime} ');
    expect(materializeOptionalBlocks(s, {}).blocks[0].params).toEqual(['from', 'to']);
  });

  it('adjacent blocks with no separator between the markers scan as two blocks', () => {
    const s = 'WHERE 1 /*[ AND a={a:UInt8} ]*//*[ AND b={b:UInt8} ]*/';
    const r = materializeOptionalBlocks(s, { a: true });
    expect(r.errors).toEqual([]);
    expect(r.blocks.map((b) => b.params)).toEqual([['a'], ['b']]);
    expect(r.sql).toBe('WHERE 1  AND a={a:UInt8} ');
    expect(materializeOptionalBlocks(s, { a: true, b: true }).sql)
      .toBe('WHERE 1  AND a={a:UInt8}  AND b={b:UInt8} ');
  });

  it('CRLF line endings are preserved byte-identically around blocks', () => {
    const s = 'WHERE 1\r\n/*[ AND d = {d:String} ]*/\r\nORDER BY 1';
    expect(materializeOptionalBlocks(s, {}).sql).toBe('WHERE 1\r\n\r\nORDER BY 1');
    expect(materializeOptionalBlocks(s, { d: true }).sql)
      .toBe('WHERE 1\r\n AND d = {d:String} \r\nORDER BY 1');
  });

  it('markers hugging the content with no spaces still scan', () => {
    const r = materializeOptionalBlocks('SELECT 1 /*[AND d = {d:String}]*/', { d: true });
    expect(r.errors).toEqual([]);
    expect(r.blocks[0].params).toEqual(['d']);
    expect(r.sql).toBe('SELECT 1 AND d = {d:String}');
    expect(materializeOptionalBlocks('SELECT {y:UInt8} /*[{d:String}]*/', {}).optionalParams).toEqual(['d']);
  });

  it('ALL_ACTIVE retains every block (the analysis view)', () => {
    const s = 'WHERE 1 /*[ AND a = {a:String} ]*/ /*[ AND b = {b:String} ]*/';
    const r = materializeOptionalBlocks(s, ALL_ACTIVE);
    expect(r.sql).toBe('WHERE 1  AND a = {a:String}   AND b = {b:String} ');
    expect(r.blocks.map((b) => b.included)).toEqual([true, true]);
  });

  it('the same param inside two blocks lists once; one also required stays out of optionalParams', () => {
    const twice = materializeOptionalBlocks(
      'WHERE 1 /*[ AND a = {x:String} ]*/ /*[ AND b = {x:String} ]*/', {});
    expect(twice.optionalParams).toEqual(['x']);
    const withinOne = materializeOptionalBlocks(
      'WHERE 1 /*[ AND (a = {x:String} OR b = {x:String}) ]*/', {});
    expect(withinOne.blocks[0].params).toEqual(['x']); // deduped within the block too
    const alsoRequired = materializeOptionalBlocks(
      'WHERE a = {x:String} /*[ AND b = {x:String} ]*/', {});
    expect(alsoRequired.requiredParams).toEqual(['x']);
    expect(alsoRequired.optionalParams).toEqual([]);
  });
});

describe('materializeOptionalBlocks — not a delimiter outside code context (rule 1)', () => {
  const untouched = (s) => {
    const r = materializeOptionalBlocks(s, {});
    expect(r.sql).toBe(s);
    expect(r.blocks).toEqual([]);
    expect(r.errors).toEqual([]);
  };
  it('inside a string literal', () => untouched("SELECT '/*[ not a block ]*/'"));
  it('inside a quoted identifier', () => untouched('SELECT "/*[ x ]*/", `/*[ y ]*/`'));
  it('inside a line comment', () => untouched('SELECT 1 -- /*[ x = {x:String} ]*/'));
  it('inside an ordinary block comment', () => untouched('SELECT 1 /* note /*[ not-a-marker */'));
  it('ordinary comments pass through untouched', () =>
    untouched('SELECT 1 /* keep me */ -- and me'));
  it('is defensive about empty/absent input', () => {
    expect(materializeOptionalBlocks(undefined)).toEqual({
      sql: '', requiredParams: [], optionalParams: [], blocks: [], errors: [],
    });
  });
});

describe('materializeOptionalBlocks — array-literal regression (the [[ … ]] collision)', () => {
  it('nested array literals pass through completely untouched', () => {
    const s = 'SELECT [[1, 2], [3, 4]]';
    const r = materializeOptionalBlocks(s, {});
    expect(r).toEqual({ sql: s, requiredParams: [], optionalParams: [], blocks: [], errors: [] });
  });
  it('a nested array literal containing a param stays a required param, text untouched', () => {
    const s = 'SELECT [[{a:UInt8}, 2], [3, 4]]';
    const r = materializeOptionalBlocks(s, {});
    expect(r.sql).toBe(s);
    expect(r.requiredParams).toEqual(['a']);
    expect(r.optionalParams).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe('materializeOptionalBlocks — validation errors (rules 3–6)', () => {
  const errOf = (s) => materializeOptionalBlocks(s, {}).errors;

  it('unbalanced /*[ (comment runs to EOF) is a clear error, sql returned verbatim', () => {
    const s = 'SELECT 1 /*[ AND d = {d:String}';
    const r = materializeOptionalBlocks(s, { d: true });
    expect(r.errors).toEqual(['optional block: unbalanced "/*[" — missing its closing "]*/"']);
    expect(r.sql).toBe(s);
    expect(r.blocks).toEqual([]);
    expect(r.optionalParams).toEqual([]);
  });

  it('a bare */ inside block content ends the comment early — rejected', () => {
    expect(errOf('SELECT 1 /*[ AND {a:UInt8} > 1 */ 2 ]*/')[0]).toContain('content cannot contain "*/"');
  });

  it('a */ inside a string literal in block content is rejected with the in-string message', () => {
    expect(errOf("SELECT 1 /*[ AND s = '*/' ]*/")[0]).toContain('ends inside a string literal');
  });

  it('review finding 1: an in-string ]*/ never truncates silently — rejected, sql verbatim', () => {
    // The comment lexer ends the block at the in-string ]*/ — the truncated
    // candidate still ends with ]*/ and would otherwise validate and mangle
    // the SQL. The reviewer's exact repro:
    const s = "WHERE 1 /*[ AND a={a:String} AND s = 'ends with ]*/ tail' ]*/";
    const r = materializeOptionalBlocks(s, { a: true });
    expect(r.errors).toEqual([
      'optional block: content ends inside a string literal — a "*/" inside a string still ends the SQL comment; remove it',
    ]);
    expect(r.sql).toBe(s); // returned verbatim — never the corrupted materialization
    expect(r.blocks).toEqual([]);
  });

  it('in-string detection honours backslash and doubled-quote escapes', () => {
    // \' keeps the literal open across the would-be terminator…
    expect(errOf("SELECT 1 /*[ AND s = 'a\\'b ]*/")[0]).toContain('ends inside a string literal');
    // …and so does a doubled '' escape.
    expect(errOf("SELECT 1 /*[ AND s = 'a''b ]*/")[0]).toContain('ends inside a string literal');
  });

  it('a string literal that closes exactly at the content end is fine', () => {
    const r = materializeOptionalBlocks("SELECT 1 /*[ AND {a:UInt8} = 'x']*/", { a: true });
    expect(r.errors).toEqual([]);
    expect(r.sql).toBe("SELECT 1  AND {a:UInt8} = 'x'");
  });

  it('nested /*[ is rejected', () => {
    expect(errOf('SELECT 1 /*[ a /*[ b = {b:String} ]*/')[0]).toContain('blocks cannot nest');
  });

  it('an ordinary block comment inside a block is rejected (its */ is the violation)', () => {
    // The inner comment's */ ends the outer comment: this candidate ends with
    // ]*/ but still carries a bare /* opener in its content.
    expect(errOf('SELECT 1 /*[ AND /* note ]*/')[0]).toContain('an ordinary block comment cannot appear');
  });

  it('a line comment inside a block is fine (its ; is not a separator either)', () => {
    const s = 'SELECT 1 /*[ AND d = {d:String} -- note; more\n]*/';
    const r = materializeOptionalBlocks(s, { d: true });
    expect(r.errors).toEqual([]);
    expect(r.sql).toBe('SELECT 1  AND d = {d:String} -- note; more\n');
  });

  it('a code-context ; inside a block is rejected; one inside a string in the content is fine', () => {
    expect(errOf('SELECT 1 /*[ ; SELECT {a:UInt8} ]*/')[0]).toContain('statement separator');
    const ok = materializeOptionalBlocks("SELECT 1 /*[ AND d = {d:String} AND s = ';' ]*/", {});
    expect(ok.errors).toEqual([]);
  });

  it('a parameterless block is rejected (a param inside a line comment does not count)', () => {
    expect(errOf('SELECT 1 /*[ AND 1 = 1 ]*/')[0]).toContain('at least one {name:Type} parameter');
    expect(errOf('SELECT 1 /*[ -- {a:UInt8}\n]*/')[0]).toContain('at least one {name:Type} parameter');
    expect(errOf('SELECT 1 /*[]*/')[0]).toContain('at least one {name:Type} parameter'); // empty content
  });

  it('a block wrapping the whole statement is rejected', () => {
    expect(errOf('/*[ SELECT {a:String} ]*/')).toEqual(['optional block: a block cannot wrap a whole statement']);
    expect(errOf('  /*[ SELECT {a:String} ]*/  ')[0]).toContain('whole statement');
  });

  it('a statement whose only code is a string literal is NOT whole-statement-wrapped', () => {
    const r = materializeOptionalBlocks("'lone literal' /*[ AND d = {d:String} ]*/", {});
    expect(r.errors).toEqual([]);
    expect(r.sql).toBe("'lone literal' ");
  });

  it('several violations report every offending block', () => {
    const errs = errOf('SELECT 1 /*[ no params ]*/ /*[ ; {a:UInt8} ]*/');
    expect(errs).toHaveLength(2);
  });
});
