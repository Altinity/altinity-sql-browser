import { describe, it, expect } from 'vitest';
import {
  functionsCapabilityFromColumns,
  buildFunctionDocSelect,
  normalizeFunctionRow,
  summaryFromEntry,
  type FunctionsDocCapability,
} from '../../src/core/doc-capability.js';

const FULL_COLS = [
  'name', 'is_aggregate', 'alias_to', 'description', 'syntax', 'arguments',
  'parameters', 'returned_value', 'examples', 'introduced_in', 'categories',
  'deterministic', 'higher_order', 'case_insensitive', 'origin',
];

// Pre-26.6-style partial schema: name + the oldest/simplest rich columns only,
// no introduced_in/deterministic/higher_order/case_insensitive/origin.
const PARTIAL_COLS = ['name', 'is_aggregate', 'alias_to', 'description', 'syntax'];

describe('functionsCapabilityFromColumns', () => {
  it('full column set: every flag confirmed', () => {
    const cap = functionsCapabilityFromColumns(FULL_COLS);
    expect(cap).toEqual({
      available: true,
      isAggregate: true,
      aliasTo: true,
      description: true,
      syntax: true,
      arguments: true,
      parameters: true,
      returnedValue: true,
      examples: true,
      introducedIn: true,
      categories: true,
      deterministic: true,
      higherOrder: true,
      caseInsensitive: true,
      origin: true,
    });
  });

  it('minimal set (name only): available, everything else false', () => {
    const cap = functionsCapabilityFromColumns(['name']);
    expect(cap.available).toBe(true);
    expect(cap.isAggregate).toBe(false);
    expect(cap.description).toBe(false);
    expect(cap.syntax).toBe(false);
    expect(cap.categories).toBe(false);
    expect(cap.deterministic).toBe(false);
    expect(cap.higherOrder).toBe(false);
  });

  it('missing table (empty column list): unavailable', () => {
    expect(functionsCapabilityFromColumns([])).toEqual(
      expect.objectContaining({ available: false }),
    );
  });

  it('missing name column even with other columns present: unavailable', () => {
    expect(functionsCapabilityFromColumns(['description', 'syntax']).available).toBe(false);
  });

  it('pre-26.6-style partial schema: only the confirmed subset is true', () => {
    const cap = functionsCapabilityFromColumns(PARTIAL_COLS);
    expect(cap.available).toBe(true);
    expect(cap.isAggregate).toBe(true);
    expect(cap.aliasTo).toBe(true);
    expect(cap.description).toBe(true);
    expect(cap.syntax).toBe(true);
    expect(cap.arguments).toBe(false);
    expect(cap.parameters).toBe(false);
    expect(cap.returnedValue).toBe(false);
    expect(cap.examples).toBe(false);
    expect(cap.introducedIn).toBe(false);
    expect(cap.categories).toBe(false);
    expect(cap.deterministic).toBe(false);
    expect(cap.higherOrder).toBe(false);
  });
});

describe('buildFunctionDocSelect', () => {
  const escape = (s: string) => `'${s.replace(/'/g, "''")}'`;

  it('unavailable capability builds no query', () => {
    const cap = functionsCapabilityFromColumns([]);
    expect(buildFunctionDocSelect(cap, 'upper', escape)).toBeNull();
  });

  it('full capability: every confirmed column listed, exact/lower/upper WHERE, escape applied', () => {
    const cap = functionsCapabilityFromColumns(FULL_COLS);
    const sql = buildFunctionDocSelect(cap, "o'brien", escape);
    const x = escape("o'brien");
    expect(sql).toBe(
      'SELECT name, is_aggregate, alias_to, description, syntax, arguments, parameters, returned_value, ' +
      'examples, introduced_in, categories, deterministic, higher_order FROM system.functions' +
      ' WHERE name = ' + x + ' OR lower(name) = lower(' + x + ') OR upper(name) = upper(' + x + ')' +
      ' LIMIT 1 FORMAT JSON',
    );
  });

  it('minimal capability: only `name` is selected', () => {
    const cap = functionsCapabilityFromColumns(['name']);
    const sql = buildFunctionDocSelect(cap, 'upper', escape);
    expect(sql).toBe(
      "SELECT name FROM system.functions WHERE name = 'upper' OR lower(name) = lower('upper')" +
      " OR upper(name) = upper('upper') LIMIT 1 FORMAT JSON",
    );
  });

  it('partial capability: only confirmed columns appear, in stable order', () => {
    const cap = functionsCapabilityFromColumns(PARTIAL_COLS);
    const sql = buildFunctionDocSelect(cap, 'ucase', escape);
    expect(sql).toContain('SELECT name, is_aggregate, alias_to, description, syntax FROM system.functions');
    expect(sql).not.toContain('categories');
    expect(sql).not.toContain('returned_value');
  });
});

describe('normalizeFunctionRow', () => {
  const fullCap = functionsCapabilityFromColumns(FULL_COLS);
  const minimalCap = functionsCapabilityFromColumns(['name']);
  const partialCap = functionsCapabilityFromColumns(PARTIAL_COLS);

  it('alias row: scalar function, alias notice, blank rich fields', () => {
    const entry = normalizeFunctionRow(
      {
        name: 'ucase', is_aggregate: 0, alias_to: 'upper', description: '', syntax: '',
        introduced_in: '', categories: '', deterministic: 1, higher_order: 0,
      },
      fullCap,
    );
    expect(entry.target).toEqual({ kind: 'function', name: 'ucase' });
    expect(entry.title).toBe('ucase');
    expect(entry.signature).toBe('ucase()'); // blank syntax falls back to name + '()'
    expect(entry.summary).toBe(''); // blank description
    expect(entry.aliasTo).toBe('upper');
    expect(entry.introducedIn).toBeUndefined(); // blank -> omitted
    expect(entry.description).toBeUndefined(); // blank -> omitted
    expect(entry.categories).toEqual([]); // blank categories string
    expect(entry.deterministic).toBe(true);
    expect(entry.higherOrder).toBe(false);
  });

  it('rich row: multi-line syntax signature, leading-blank-line description, categories with blanks', () => {
    const entry = normalizeFunctionRow(
      {
        name: 'toStartOfInterval',
        is_aggregate: 0,
        alias_to: '', // confirmed column, blank value -> omitted
        description: '\nRounds down a date/time to the start of an interval.\nMore detail.',
        syntax: 'toStartOfInterval(value, INTERVAL x unit[, time_zone])\ntoStartOfInterval(value, INTERVAL x unit, origin[, time_zone])',
        arguments: 'value — a Date/DateTime.',
        parameters: '', // confirmed, blank -> omitted
        returned_value: 'The rounded date/time.',
        examples: '', // confirmed, blank -> omitted
        introduced_in: '22.1',
        categories: 'Dates and Times, ,Other',
        deterministic: 1,
        higher_order: 0,
      },
      fullCap,
    );
    expect(entry.signature).toBe('toStartOfInterval(value, INTERVAL x unit[, time_zone])');
    expect(entry.summary).toBe('Rounds down a date/time to the start of an interval.');
    expect(entry.description).toBe(
      'Rounds down a date/time to the start of an interval.\nMore detail.',
    );
    expect(entry.aliasTo).toBeUndefined();
    expect(entry.arguments).toBe('value — a Date/DateTime.');
    expect(entry.parameters).toBeUndefined();
    expect(entry.returnedValue).toBe('The rounded date/time.');
    expect(entry.examples).toBeUndefined();
    expect(entry.introducedIn).toBe('22.1');
    expect(entry.categories).toEqual(['Dates and Times', 'Other']);
    expect(entry.deterministic).toBe(true);
    expect(entry.higherOrder).toBe(false);
  });

  it('aggregate row: is_aggregate truthy -> aggregate-function kind, nullable tri-state fields', () => {
    const entry = normalizeFunctionRow(
      {
        name: 'sum',
        is_aggregate: 1,
        alias_to: '',
        description: '\nComputes the sum.',
        syntax: 'sum(x)',
        arguments: '', // blank -> omitted
        parameters: 'p1', // defined -> kept
        returned_value: '', // blank -> omitted
        examples: 'SELECT sum(x)', // defined -> kept
        introduced_in: '1.0',
        categories: 'Aggregate Functions',
        deterministic: null,
        higher_order: null,
      },
      fullCap,
    );
    expect(entry.target).toEqual({ kind: 'aggregate-function', name: 'sum' });
    expect(entry.categories).toEqual(['Aggregate Functions']);
    expect(entry.parameters).toBe('p1');
    expect(entry.returnedValue).toBeUndefined();
    expect(entry.examples).toBe('SELECT sum(x)');
    expect(entry.arguments).toBeUndefined();
    expect(entry.deterministic).toBeNull();
    expect(entry.higherOrder).toBeNull();
  });

  it('minimal row (name only known): every rich field degrades to its absent-column default', () => {
    const entry = normalizeFunctionRow({ name: 'now' }, minimalCap);
    expect(entry.target).toEqual({ kind: 'function', name: 'now' });
    expect(entry.signature).toBe('now()');
    expect(entry.summary).toBe('');
    expect(entry.categories).toEqual([]);
    expect(entry.aliasTo).toBeUndefined();
    expect(entry.introducedIn).toBeUndefined();
    expect(entry.description).toBeUndefined();
    expect(entry.arguments).toBeUndefined();
    expect(entry.parameters).toBeUndefined();
    expect(entry.returnedValue).toBeUndefined();
    expect(entry.examples).toBeUndefined();
    expect(entry.deterministic).toBeUndefined();
    expect(entry.higherOrder).toBeUndefined();
    // extra unknown fields on the raw row (a stray key beyond the SELECT) are ignored
    expect((entry as unknown as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it('pre-26.6-style partial schema: confirmed subset normalizes, the rest degrades', () => {
    const entry = normalizeFunctionRow(
      { name: 'upper', is_aggregate: 0, alias_to: '', description: '\nConverts to uppercase.', syntax: 'upper(s)' },
      partialCap,
    );
    expect(entry.target).toEqual({ kind: 'function', name: 'upper' });
    expect(entry.signature).toBe('upper(s)');
    expect(entry.summary).toBe('Converts to uppercase.');
    expect(entry.introducedIn).toBeUndefined();
    expect(entry.categories).toEqual([]);
    expect(entry.deterministic).toBeUndefined();
    expect(entry.higherOrder).toBeUndefined();
  });

  it('all-blank multi-line syntax/description (only blank lines) falls back cleanly', () => {
    const entry = normalizeFunctionRow(
      { name: 'x', syntax: '\n \n', description: '\n\n ' },
      fullCap,
    );
    expect(entry.signature).toBe('x()'); // every line blank -> firstLine falls through to ''
    expect(entry.summary).toBe('');
  });

  it('never throws on an unexpected/missing name', () => {
    expect(() => normalizeFunctionRow({}, minimalCap)).not.toThrow();
    const entry = normalizeFunctionRow({}, minimalCap);
    expect(entry.title).toBe('');
    expect(entry.signature).toBe('()');
  });
});

describe('summaryFromEntry', () => {
  it('projects the summary-shaped subset, omitting entry-only fields', () => {
    const cap: FunctionsDocCapability = functionsCapabilityFromColumns(['name', 'alias_to', 'introduced_in', 'syntax', 'description']);
    const entry = normalizeFunctionRow(
      { name: 'ucase', alias_to: 'upper', introduced_in: '20.1', syntax: 'ucase(s)', description: '\nAlias of upper.' },
      cap,
    );
    const summary = summaryFromEntry(entry);
    expect(summary).toEqual({
      target: { kind: 'function', name: 'ucase' },
      title: 'ucase',
      signature: 'ucase(s)',
      summary: 'Alias of upper.',
      introducedIn: '20.1',
      aliasTo: 'upper',
    });
  });

  it('omits introducedIn/aliasTo when the entry lacks them', () => {
    const cap = functionsCapabilityFromColumns(['name']);
    const entry = normalizeFunctionRow({ name: 'now' }, cap);
    const summary = summaryFromEntry(entry);
    expect(summary).toEqual({
      target: { kind: 'function', name: 'now' },
      title: 'now',
      signature: 'now()',
      summary: '',
    });
    expect(summary.introducedIn).toBeUndefined();
    expect(summary.aliasTo).toBeUndefined();
  });
});
