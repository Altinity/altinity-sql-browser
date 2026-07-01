import { describe, it, expect } from 'vitest';
import { toTSV, formatFileMeta, exportFilename } from '../../src/core/export.js';

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
