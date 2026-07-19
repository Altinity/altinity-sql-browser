// Pure serializers + file-naming helpers for exporting result data. `toTSV`
// backs the results pane's Copy (pastes into spreadsheets); `formatFileMeta` /
// `exportFilename` back the streaming Export button (issue #87), which streams
// a ClickHouse response straight to disk rather than serializing rows itself;
// `scriptExportName` backs the multi-statement script export (issue #99). No
// DOM, no globals.

import { inferQueryName } from './format.js';

/** The minimal result-column shape `toTSV` reads (a name to head the TSV). */
export interface ExportColumn {
  name: string;
  [k: string]: unknown;
}

function cell(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * TabSeparated text: a header row of column names + one line per data row.
 * Backslashes, tabs and newlines are escaped ClickHouse-TSV style so embedded
 * whitespace can't break the column/row grid when pasted.
 */
export function toTSV(columns: ExportColumn[], rows: unknown[][]): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const head = columns.map((c) => esc(c.name)).join('\t');
  const body = rows.map((row) => row.map((v) => esc(cell(v))).join('\t')).join('\n');
  return rows.length ? head + '\n' + body : head;
}

/** The `{ext, mime}` shape `formatFileMeta` resolves for a ClickHouse output format. */
export interface FileMeta {
  ext: string;
  mime: string;
}

/**
 * File extension + MIME for a ClickHouse output format, matched by family so
 * the long tail of ~90 format names doesn't need enumerating. Unknown/
 * pretty-text formats fall back to `.txt`. `mime` feeds showSaveFilePicker's
 * `accept`. Pure.
 */
export function formatFileMeta(format?: string | null): FileMeta {
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
  if (/^PNG$/i.test(f)) return { ext: 'png', mime: 'image/png' };
  return { ext: 'txt', mime: 'text/plain' }; // Pretty*, Vertical, Values, unknown
}

/**
 * Suggested download filename: the sanitized tab name (or a timestamp
 * fallback when it's blank/all-punctuation) + the format's extension. `now`
 * is injected (Date.now()) for deterministic tests. Pure.
 */
export function exportFilename(tabName: string | null | undefined, now: number, ext?: string | null): string {
  const base = String(tabName || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
    || 'export-' + new Date(now).toISOString().replace(/[:.]/g, '-');
  return base + '.' + (ext || 'tsv');
}

/**
 * Deterministic per-statement export filename: `<NNN>-<slug>.<ext>` (e.g.
 * `001-select.tsv`). `index` is the statement's 0-based position in the script;
 * the prefix is `index+1` zero-padded to 3, so it matches the log pane's `#`
 * column (non-row statements consume a number, leaving intentional gaps). `slug`
 * comes from inferQueryName → sanitized, lowercased, ≤ 24 chars (empty → 'query').
 * `taken` (Set of names already used this run) de-dupes with `-2`, `-3`, …
 * Pure — the caller adds the returned name to `taken`.
 */
export function scriptExportName(index: number, stmt: string, ext: string, taken?: Set<string>): string {
  const num = String(index + 1).padStart(3, '0');
  const slug = (inferQueryName(stmt).replace(/^Query · /, '') || stmt)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'query';
  let name = `${num}-${slug}.${ext}`;
  for (let n = 2; taken && taken.has(name); n++) name = `${num}-${slug}-${n}.${ext}`;
  return name;
}
