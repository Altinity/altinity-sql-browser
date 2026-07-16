import { describe, it, expect } from 'vitest';
import { toTSV, formatFileMeta, exportFilename, scriptExportName } from '../../src/core/export.js';

const cols = [{ name: 'a' }, { name: 'b' }];

describe('toTSV', () => {
  it('header + rows, null → empty cell', () => {
    expect(toTSV(cols, [[1, 'x'], [2, null]])).toBe('a\tb\n1\tx\n2\t');
  });
  it('escapes backslash, tab, newline, CR ClickHouse-style', () => {
    expect(toTSV([{ name: 'c' }], [['x\ty\nz\\w\r']])).toBe('c\nx\\ty\\nz\\\\w\\r');
  });
  it('header only when there are no rows', () => {
    expect(toTSV(cols, [])).toBe('a\tb');
  });
});

describe('formatFileMeta', () => {
  it('maps each format family to its extension + MIME', () => {
    expect(formatFileMeta('JSONEachRow')).toEqual({ ext: 'jsonl', mime: 'application/x-ndjson' });
    expect(formatFileMeta('NDJSON')).toEqual({ ext: 'jsonl', mime: 'application/x-ndjson' });
    expect(formatFileMeta('JSON')).toEqual({ ext: 'json', mime: 'application/json' });
    expect(formatFileMeta('JSONCompact')).toEqual({ ext: 'json', mime: 'application/json' });
    expect(formatFileMeta('CSV')).toEqual({ ext: 'csv', mime: 'text/csv' });
    expect(formatFileMeta('CSVWithNames')).toEqual({ ext: 'csv', mime: 'text/csv' });
    expect(formatFileMeta('TSV')).toEqual({ ext: 'tsv', mime: 'text/tab-separated-values' });
    expect(formatFileMeta('TabSeparatedWithNames')).toEqual({ ext: 'tsv', mime: 'text/tab-separated-values' });
    expect(formatFileMeta('Parquet')).toEqual({ ext: 'parquet', mime: 'application/vnd.apache.parquet' });
    expect(formatFileMeta('Arrow')).toEqual({ ext: 'arrow', mime: 'application/vnd.apache.arrow.file' });
    expect(formatFileMeta('ArrowStream')).toEqual({ ext: 'arrow', mime: 'application/vnd.apache.arrow.file' });
    expect(formatFileMeta('ORC')).toEqual({ ext: 'orc', mime: 'application/octet-stream' });
    expect(formatFileMeta('Avro')).toEqual({ ext: 'avro', mime: 'application/octet-stream' });
    expect(formatFileMeta('Native')).toEqual({ ext: 'native', mime: 'application/octet-stream' });
    expect(formatFileMeta('RowBinary')).toEqual({ ext: 'bin', mime: 'application/octet-stream' });
    expect(formatFileMeta('RawBLOB')).toEqual({ ext: 'bin', mime: 'application/octet-stream' });
    expect(formatFileMeta('XML')).toEqual({ ext: 'xml', mime: 'application/xml' });
    expect(formatFileMeta('Markdown')).toEqual({ ext: 'md', mime: 'text/markdown' });
    expect(formatFileMeta('SQLInsert')).toEqual({ ext: 'sql', mime: 'application/sql' });
  });
  it('falls back to txt for Pretty/Vertical/Values/unknown formats', () => {
    expect(formatFileMeta('PrettyCompact')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(formatFileMeta('Vertical')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(formatFileMeta('Values')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(formatFileMeta('')).toEqual({ ext: 'txt', mime: 'text/plain' });
    expect(formatFileMeta()).toEqual({ ext: 'txt', mime: 'text/plain' });
  });
});

describe('exportFilename', () => {
  it('sanitizes the tab name and appends the given extension', () => {
    expect(exportFilename('My Query!', 0, 'tsv')).toBe('My_Query.tsv');
  });
  it('falls back to a timestamp when the name is blank/all punctuation', () => {
    expect(exportFilename('!!!', 1735689600000, 'csv')).toBe('export-2025-01-01T00-00-00-000Z.csv');
    expect(exportFilename('', 1735689600000, 'csv')).toBe('export-2025-01-01T00-00-00-000Z.csv');
    expect(exportFilename(null, 1735689600000, 'csv')).toBe('export-2025-01-01T00-00-00-000Z.csv');
  });
  it('defaults the extension to tsv when omitted', () => {
    expect(exportFilename('result', 0)).toBe('result.tsv');
  });
});

describe('scriptExportName', () => {
  it('zero-pads the index (1-based) and slugs the statement', () => {
    expect(scriptExportName(0, 'SELECT 1', 'tsv', new Set())).toBe('001-select-1.tsv');
    expect(scriptExportName(99, 'SELECT 1', 'tsv', new Set())).toBe('100-select-1.tsv');
    expect(scriptExportName(4, 'SELECT 1', 'csv', new Set())).toBe('005-select-1.csv');
  });
  it('slugs from inferQueryName, stripping the "Query · " prefix', () => {
    expect(scriptExportName(0, 'SELECT * FROM my_table', 'tsv', new Set())).toBe('001-my-table.tsv');
  });
  it('falls back to "query" when the statement is empty', () => {
    expect(scriptExportName(0, '', 'tsv', new Set())).toBe('001-query.tsv');
  });
  it('falls back to "query" when the slug sanitizes to nothing (all punctuation)', () => {
    expect(scriptExportName(0, ';;;', 'tsv', new Set())).toBe('001-query.tsv');
  });
  it('truncates the slug to 24 chars', () => {
    const stmt = 'SELECT * FROM abcdefghijklmnopqrstuvwxyz';
    expect(scriptExportName(0, stmt, 'tsv', new Set())).toBe('001-abcdefghijklmnopqrstuvwx.tsv');
  });
  it('de-dupes against `taken` with -2, -3, …', () => {
    const taken = new Set(['001-select.tsv', '001-select-2.tsv']);
    expect(scriptExportName(0, 'SELECT', 'tsv', taken)).toBe('001-select-3.tsv');
  });
  it('works without a `taken` set (no dedup)', () => {
    expect(scriptExportName(0, 'SELECT 1', 'tsv')).toBe('001-select-1.tsv');
  });
});
