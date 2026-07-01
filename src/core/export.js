// Pure serializers + file-naming helpers for exporting result data. `toTSV`
// backs the results pane's Copy (pastes into spreadsheets); `formatFileMeta` /
// `exportFilename` back the streaming Export button (issue #87), which streams
// a ClickHouse response straight to disk rather than serializing rows itself.
// No DOM, no globals.

function cell(v) {
  return v == null ? '' : String(v);
}

/**
 * TabSeparated text: a header row of column names + one line per data row.
 * Backslashes, tabs and newlines are escaped ClickHouse-TSV style so embedded
 * whitespace can't break the column/row grid when pasted.
 */
export function toTSV(columns, rows) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const head = columns.map((c) => esc(c.name)).join('\t');
  const body = rows.map((row) => row.map((v) => esc(cell(v))).join('\t')).join('\n');
  return rows.length ? head + '\n' + body : head;
}

/**
 * File extension + MIME for a ClickHouse output format, matched by family so
 * the long tail of ~90 format names doesn't need enumerating. Unknown/
 * pretty-text formats fall back to `.txt`. `mime` feeds showSaveFilePicker's
 * `accept`. Pure.
 */
export function formatFileMeta(format) {
  const f = String(format || '');
  if (/EachRow$/i.test(f) || /^NDJSON$/i.test(f)) return { ext: 'jsonl', mime: 'application/x-ndjson' };
  if (/^JSON/i.test(f)) return { ext: 'json', mime: 'application/json' };
  if (/^CSV/i.test(f)) return { ext: 'csv', mime: 'text/csv' };
  if (/^(TSV|TabSeparated)/i.test(f)) return { ext: 'tsv', mime: 'text/tab-separated-values' };
  if (/^Parquet$/i.test(f)) return { ext: 'parquet', mime: 'application/vnd.apache.parquet' };
  if (/^(Arrow|ArrowStream)$/i.test(f)) return { ext: 'arrow', mime: 'application/vnd.apache.arrow.file' };
  if (/^ORC$/i.test(f)) return { ext: 'orc', mime: 'application/octet-stream' };
  if (/^Avro$/i.test(f)) return { ext: 'avro', mime: 'application/octet-stream' };
  if (/^Native$/i.test(f)) return { ext: 'native', mime: 'application/octet-stream' };
  if (/^(RowBinary|RawBLOB)/i.test(f)) return { ext: 'bin', mime: 'application/octet-stream' };
  if (/^XML$/i.test(f)) return { ext: 'xml', mime: 'application/xml' };
  if (/^Markdown$/i.test(f)) return { ext: 'md', mime: 'text/markdown' };
  if (/^SQLInsert$/i.test(f)) return { ext: 'sql', mime: 'application/sql' };
  return { ext: 'txt', mime: 'text/plain' }; // Pretty*, Vertical, Values, unknown
}

/**
 * Suggested download filename: the sanitized tab name (or a timestamp
 * fallback when it's blank/all-punctuation) + the format's extension. `now`
 * is injected (Date.now()) for deterministic tests. Pure.
 */
export function exportFilename(tabName, now, ext) {
  const base = String(tabName || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
    || 'export-' + new Date(now).toISOString().replace(/[:.]/g, '-');
  return base + '.' + (ext || 'tsv');
}
