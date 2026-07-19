import { describe, it, expect } from 'vitest';
import {
  functionsCapabilityFromColumns,
  buildFunctionDocSelect,
  normalizeFunctionRow,
  summaryFromEntry,
  structuredCapabilityFromColumns,
  buildStructuredDocSelect,
  normalizeStructuredRow,
  type FunctionsDocCapability,
  type StructuredDocKind,
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

// ── #314 Phase 2 — structured sources (format/table-engine/database-engine/data-type) ──

// Real 26.6.1 server column inventories (live-verified — treated as ONE
// possible shape, never hard-coded elsewhere in the module under test).
const FORMAT_FULL_COLS = [
  'name', 'is_input', 'is_output', 'supports_parallel_parsing', 'supports_parallel_formatting',
  'is_tty_friendly', 'content_type', 'supports_random_access', 'has_schema_inference',
  'has_external_schema', 'prefers_large_blocks', 'supports_append', 'supports_subsets_of_columns',
  'description', 'examples', 'introduced_in', 'related',
];
const TABLE_ENGINE_FULL_COLS = [
  'name', 'supports_settings', 'supports_skipping_indices', 'supports_projections',
  'supports_sort_order', 'supports_ttl', 'supports_replication', 'supports_deduplication',
  'supports_parallel_insert', 'description', 'syntax', 'examples', 'introduced_in', 'related',
];
const DATABASE_ENGINE_FULL_COLS = ['name', 'description', 'syntax', 'examples', 'introduced_in', 'related'];
const DATA_TYPE_FULL_COLS = ['name', 'case_insensitive', 'alias_to', 'description', 'syntax', 'examples', 'introduced_in', 'related'];

describe('structuredCapabilityFromColumns', () => {
  it('format: full column set confirms every non-syntax flag, never syntax', () => {
    const cap = structuredCapabilityFromColumns('format', FORMAT_FULL_COLS);
    expect(cap.available).toBe(true);
    expect(cap.syntax).toBe(false); // system.formats has no syntax column — never true
    expect(cap.isInput).toBe(true);
    expect(cap.isOutput).toBe(true);
    expect(cap.supportsParallelParsing).toBe(true);
    expect(cap.supportsParallelFormatting).toBe(true);
    expect(cap.isTtyFriendly).toBe(true);
    expect(cap.contentType).toBe(true);
    expect(cap.supportsRandomAccess).toBe(true);
    expect(cap.hasSchemaInference).toBe(true);
    expect(cap.hasExternalSchema).toBe(true);
    expect(cap.prefersLargeBlocks).toBe(true);
    expect(cap.supportsAppend).toBe(true);
    expect(cap.supportsSubsetsOfColumns).toBe(true);
    expect(cap.description).toBe(true);
    expect(cap.examples).toBe(true);
    expect(cap.introducedIn).toBe(true);
    expect(cap.related).toBe(true);
    expect(cap.aliasTo).toBe(false); // not a format column
  });

  it('format: even a probe that somehow reports a "syntax" column never sets the flag true', () => {
    // Defensive: system.formats never has this column in reality, but the
    // capability decider must not have a code path that could ever honor it.
    const cap = structuredCapabilityFromColumns('format', [...FORMAT_FULL_COLS, 'syntax']);
    expect(cap.syntax).toBe(false);
  });

  it('table-engine: full column set confirms every flag including syntax', () => {
    const cap = structuredCapabilityFromColumns('table-engine', TABLE_ENGINE_FULL_COLS);
    expect(cap.available).toBe(true);
    expect(cap.supportsSettings).toBe(true);
    expect(cap.supportsSkippingIndices).toBe(true);
    expect(cap.supportsProjections).toBe(true);
    expect(cap.supportsSortOrder).toBe(true);
    expect(cap.supportsTtl).toBe(true);
    expect(cap.supportsReplication).toBe(true);
    expect(cap.supportsDeduplication).toBe(true);
    expect(cap.supportsParallelInsert).toBe(true);
    expect(cap.description).toBe(true);
    expect(cap.syntax).toBe(true);
    expect(cap.examples).toBe(true);
    expect(cap.introducedIn).toBe(true);
    expect(cap.related).toBe(true);
    // format-only / data-type-only flags never set for this kind.
    expect(cap.isInput).toBe(false);
    expect(cap.aliasTo).toBe(false);
  });

  it('database-engine: full column set confirms description/syntax/examples/introducedIn/related only', () => {
    const cap = structuredCapabilityFromColumns('database-engine', DATABASE_ENGINE_FULL_COLS);
    expect(cap).toEqual(expect.objectContaining({
      available: true, description: true, syntax: true, examples: true, introducedIn: true, related: true,
    }));
    expect(cap.aliasTo).toBe(false);
    expect(cap.supportsSettings).toBe(false);
    expect(cap.isInput).toBe(false);
  });

  it('data-type: full column set confirms aliasTo, never tracks case_insensitive as a flag', () => {
    const cap = structuredCapabilityFromColumns('data-type', DATA_TYPE_FULL_COLS);
    expect(cap.available).toBe(true);
    expect(cap.aliasTo).toBe(true);
    expect(cap.description).toBe(true);
    expect(cap.syntax).toBe(true);
    expect(cap.examples).toBe(true);
    expect(cap.introducedIn).toBe(true);
    expect(cap.related).toBe(true);
    // No flag exists for case_insensitive at all — it's metadata, not surfaced.
    expect(cap as unknown as Record<string, unknown>).not.toHaveProperty('caseInsensitive');
  });

  it('missing name column: unavailable for every kind, regardless of other columns present', () => {
    const kinds: StructuredDocKind[] = ['format', 'table-engine', 'database-engine', 'data-type'];
    for (const kind of kinds) {
      expect(structuredCapabilityFromColumns(kind, ['description', 'syntax']).available).toBe(false);
    }
  });

  it('missing table (empty column list): unavailable', () => {
    expect(structuredCapabilityFromColumns('table-engine', []).available).toBe(false);
  });

  it('pre-26.6-style partial schema (name + description only): rest degrades per kind', () => {
    const cap = structuredCapabilityFromColumns('table-engine', ['name', 'description']);
    expect(cap.available).toBe(true);
    expect(cap.description).toBe(true);
    expect(cap.syntax).toBe(false);
    expect(cap.examples).toBe(false);
    expect(cap.introducedIn).toBe(false);
    expect(cap.related).toBe(false);
    expect(cap.supportsSettings).toBe(false);
  });

  it('minimal set (name only): available, everything else false', () => {
    const cap = structuredCapabilityFromColumns('data-type', ['name']);
    expect(cap.available).toBe(true);
    expect(cap.aliasTo).toBe(false);
    expect(cap.syntax).toBe(false);
    expect(cap.related).toBe(false);
  });
});

describe('buildStructuredDocSelect', () => {
  const escape = (s: string) => `'${s.replace(/'/g, "''")}'`;

  it('unavailable capability builds no query', () => {
    const cap = structuredCapabilityFromColumns('format', []);
    expect(buildStructuredDocSelect('format', cap, 'CSV', escape)).toBeNull();
  });

  it('format: full capability lists every confirmed column, FROM system.formats, and NEVER selects syntax', () => {
    const cap = structuredCapabilityFromColumns('format', FORMAT_FULL_COLS);
    const sql = buildStructuredDocSelect('format', cap, 'CSV', escape)!;
    expect(sql).toContain('FROM system.formats');
    expect(sql).toContain('SELECT name, is_input, is_output, supports_parallel_parsing, supports_parallel_formatting, '
      + 'is_tty_friendly, supports_random_access, has_schema_inference, has_external_schema, prefers_large_blocks, '
      + 'supports_append, supports_subsets_of_columns, content_type, description, examples, introduced_in, related');
    // Hard assertion (#314): system.formats has no syntax column — this SELECT
    // must never mention it, under any capability state.
    expect(sql).not.toMatch(/\bsyntax\b/);
  });

  it('table-engine: full capability lists every confirmed column including syntax, FROM system.table_engines', () => {
    const cap = structuredCapabilityFromColumns('table-engine', TABLE_ENGINE_FULL_COLS);
    const sql = buildStructuredDocSelect('table-engine', cap, 'MergeTree', escape)!;
    expect(sql).toContain('FROM system.table_engines');
    expect(sql).toContain('syntax');
    expect(sql).toContain('supports_settings');
  });

  it('database-engine: FROM system.database_engines, name-only case-insensitive WHERE', () => {
    const cap = structuredCapabilityFromColumns('database-engine', ['name']);
    const sql = buildStructuredDocSelect('database-engine', cap, 'Atomic', escape)!;
    expect(sql).toBe(
      "SELECT name FROM system.database_engines WHERE name = 'Atomic' OR lower(name) = lower('Atomic')"
      + " OR upper(name) = upper('Atomic') LIMIT 1 FORMAT JSON",
    );
  });

  it('data-type: FROM system.data_type_families, escape applied, exact/lower/upper WHERE', () => {
    const cap = structuredCapabilityFromColumns('data-type', DATA_TYPE_FULL_COLS);
    const sql = buildStructuredDocSelect('data-type', cap, "o'brien", escape);
    const x = escape("o'brien");
    expect(sql).toBe(
      'SELECT name, alias_to, description, syntax, examples, introduced_in, related FROM system.data_type_families'
      + ' WHERE name = ' + x + ' OR lower(name) = lower(' + x + ') OR upper(name) = upper(' + x + ')'
      + ' LIMIT 1 FORMAT JSON',
    );
    // case_insensitive is never selected, even when it was a confirmed column.
    const capWithCaseInsensitive = structuredCapabilityFromColumns('data-type', [...DATA_TYPE_FULL_COLS]);
    const sql2 = buildStructuredDocSelect('data-type', capWithCaseInsensitive, 'Int32', escape)!;
    expect(sql2).not.toContain('case_insensitive');
  });

  it('partial capability: only confirmed columns appear, in stable order', () => {
    const cap = structuredCapabilityFromColumns('table-engine', ['name', 'description', 'related']);
    const sql = buildStructuredDocSelect('table-engine', cap, 'Log', escape)!;
    expect(sql).toContain('SELECT name, description, related FROM system.table_engines');
    expect(sql).not.toContain('syntax');
    expect(sql).not.toContain('supports_settings');
  });
});

describe('normalizeStructuredRow', () => {
  it('format row: no syntax anywhere, facts derived only from confirmed non-null booleans, content_type fact', () => {
    const cap = structuredCapabilityFromColumns('format', FORMAT_FULL_COLS);
    const entry = normalizeStructuredRow('format', {
      name: 'CSV',
      is_input: 1, is_output: 1, supports_parallel_parsing: 1, supports_parallel_formatting: 0,
      is_tty_friendly: 0, content_type: 'text/csv', supports_random_access: null,
      has_schema_inference: 1, has_external_schema: 0, prefers_large_blocks: 1,
      supports_append: 0, supports_subsets_of_columns: 1,
      description: '\nComma-separated values.', examples: 'SELECT * FROM t FORMAT CSV',
      introduced_in: '1.0', related: 'TSV, CSVWithNames',
    }, cap);
    expect(entry.target).toEqual({ kind: 'format', name: 'CSV' });
    expect(entry.title).toBe('CSV');
    expect(entry.signature).toBe('CSV'); // no syntax ever, no '()' suffix
    expect(entry.syntaxFull).toBeUndefined();
    expect(entry.summary).toBe('Comma-separated values.');
    expect(entry.description).toBe('Comma-separated values.');
    expect(entry.introducedIn).toBe('1.0');
    expect(entry.examples).toBe('SELECT * FROM t FORMAT CSV');
    expect(entry.related).toEqual([
      { label: 'TSV', target: { kind: 'format', name: 'TSV' } },
      { label: 'CSVWithNames', target: { kind: 'format', name: 'CSVWithNames' } },
    ]);
    // supports_random_access is confirmed but null -> omitted, not shown as false.
    expect(entry.facts).toEqual([
      { label: 'Input', value: 'yes' },
      { label: 'Output', value: 'yes' },
      { label: 'Parallel parsing', value: 'yes' },
      { label: 'Parallel formatting', value: 'no' },
      { label: 'TTY friendly', value: 'no' },
      { label: 'Schema inference', value: 'yes' },
      { label: 'External schema', value: 'no' },
      { label: 'Prefers large blocks', value: 'yes' },
      { label: 'Append', value: 'no' },
      { label: 'Column subsets', value: 'yes' },
      { label: 'Content type', value: 'text/csv' },
    ]);
    expect(entry.facts!.some((f) => f.label === 'Random access')).toBe(false);
  });

  it('format row: unconfirmed boolean columns never read even if a stray key is present on the row', () => {
    const cap = structuredCapabilityFromColumns('format', ['name']); // minimal — no capability flags confirmed
    const entry = normalizeStructuredRow('format', { name: 'Native', is_input: 1, is_output: 1 }, cap);
    expect(entry.facts).toBeUndefined();
    expect(entry.signature).toBe('Native');
  });

  it('table-engine row: full syntax block, signature is first line, facts from its own boolean columns, related as Array', () => {
    const cap = structuredCapabilityFromColumns('table-engine', TABLE_ENGINE_FULL_COLS);
    const entry = normalizeStructuredRow('table-engine', {
      name: 'MergeTree',
      supports_settings: 1, supports_skipping_indices: 1, supports_projections: 1, supports_sort_order: 1,
      supports_ttl: 1, supports_replication: 0, supports_deduplication: 0, supports_parallel_insert: 1,
      description: '\nThe base MergeTree table engine.',
      syntax: 'ENGINE = MergeTree()\nORDER BY expr\n[PARTITION BY expr]',
      examples: 'CREATE TABLE t (...) ENGINE = MergeTree() ORDER BY id',
      introduced_in: '1.0',
      related: ['ReplacingMergeTree', 'SummingMergeTree'],
    }, cap);
    expect(entry.target).toEqual({ kind: 'table-engine', name: 'MergeTree' });
    expect(entry.signature).toBe('ENGINE = MergeTree()');
    expect(entry.syntaxFull).toBe('ENGINE = MergeTree()\nORDER BY expr\n[PARTITION BY expr]');
    expect(entry.summary).toBe('The base MergeTree table engine.');
    expect(entry.related).toEqual([
      { label: 'ReplacingMergeTree', target: { kind: 'table-engine', name: 'ReplacingMergeTree' } },
      { label: 'SummingMergeTree', target: { kind: 'table-engine', name: 'SummingMergeTree' } },
    ]);
    expect(entry.facts).toEqual([
      { label: 'Settings', value: 'yes' },
      { label: 'Skipping indices', value: 'yes' },
      { label: 'Projections', value: 'yes' },
      { label: 'Sort order', value: 'yes' },
      { label: 'TTL', value: 'yes' },
      { label: 'Replication', value: 'no' },
      { label: 'Deduplication', value: 'no' },
      { label: 'Parallel insert', value: 'yes' },
    ]);
  });

  it('related confirmed but null on the row (not an empty string, not absent): treated as no related items', () => {
    const cap = structuredCapabilityFromColumns('format', FORMAT_FULL_COLS);
    const entry = normalizeStructuredRow('format', { name: 'RawBLOB', related: null }, cap);
    expect(entry.related).toBeUndefined();
  });

  it('database-engine row: no facts (no capability-flag columns on this source), casing preserved', () => {
    const cap = structuredCapabilityFromColumns('database-engine', DATABASE_ENGINE_FULL_COLS);
    const entry = normalizeStructuredRow('database-engine', {
      name: 'Atomic', description: '\nDefault database engine.', syntax: 'ENGINE = Atomic',
      examples: '', introduced_in: '20.x', related: '',
    }, cap);
    expect(entry.target).toEqual({ kind: 'database-engine', name: 'Atomic' });
    expect(entry.title).toBe('Atomic'); // canonical casing preserved verbatim
    expect(entry.signature).toBe('ENGINE = Atomic');
    expect(entry.facts).toBeUndefined();
    expect(entry.examples).toBeUndefined(); // blank -> omitted
    expect(entry.related).toBeUndefined(); // blank string -> no items -> omitted
  });

  it('data-type row: alias_to surfaces as aliasTo, case_insensitive never read even if present on the row', () => {
    const cap = structuredCapabilityFromColumns('data-type', DATA_TYPE_FULL_COLS);
    const entry = normalizeStructuredRow('data-type', {
      name: 'INT', case_insensitive: 1, alias_to: 'Int32', description: '\nAlias of Int32.',
      syntax: '', examples: '', introduced_in: '', related: '',
    }, cap);
    expect(entry.target).toEqual({ kind: 'data-type', name: 'INT' });
    expect(entry.aliasTo).toBe('Int32');
    expect(entry.signature).toBe('INT'); // blank syntax -> falls back to name, no '()' suffix
    expect(entry.syntaxFull).toBeUndefined();
    expect((entry as unknown as Record<string, unknown>).caseInsensitive).toBeUndefined();
  });

  it('data-type row: non-blank multi-line syntax -> signature is its first line, full block kept in syntaxFull', () => {
    const cap = structuredCapabilityFromColumns('data-type', DATA_TYPE_FULL_COLS);
    const entry = normalizeStructuredRow('data-type', {
      name: 'Nullable', alias_to: '', description: '', syntax: 'Nullable(T)\nT — any type except Nullable/Array/Tuple.',
      examples: '', introduced_in: '', related: '',
    }, cap);
    expect(entry.signature).toBe('Nullable(T)');
    expect(entry.syntaxFull).toBe('Nullable(T)\nT — any type except Nullable/Array/Tuple.');
    expect(entry.aliasTo).toBeUndefined();
  });

  it('unknown extra fields on the raw row are ignored', () => {
    const cap = structuredCapabilityFromColumns('data-type', ['name']);
    const entry = normalizeStructuredRow('data-type', { name: 'String', unknownField: 'x' }, cap);
    expect((entry as unknown as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it('minimal row (name only known): every rich field degrades to its absent-column default', () => {
    const cap = structuredCapabilityFromColumns('format', ['name']);
    const entry = normalizeStructuredRow('format', { name: 'Parquet' }, cap);
    expect(entry.target).toEqual({ kind: 'format', name: 'Parquet' });
    expect(entry.signature).toBe('Parquet');
    expect(entry.summary).toBe('');
    expect(entry.categories).toEqual([]);
    expect(entry.introducedIn).toBeUndefined();
    expect(entry.description).toBeUndefined();
    expect(entry.examples).toBeUndefined();
    expect(entry.related).toBeUndefined();
    expect(entry.facts).toBeUndefined();
    expect(entry.aliasTo).toBeUndefined();
    expect(entry.syntaxFull).toBeUndefined();
  });

  it('never throws on an unexpected/missing name', () => {
    const cap = structuredCapabilityFromColumns('format', ['name']);
    expect(() => normalizeStructuredRow('format', {}, cap)).not.toThrow();
    const entry = normalizeStructuredRow('format', {}, cap);
    expect(entry.title).toBe('');
    expect(entry.signature).toBe('');
  });
});
