// Pure serializers turning result data (columns + rows) into TSV / CSV text.
// Used by the results pane's Copy (TSV — pastes into spreadsheets) and Export
// (CSV — opens in Excel) actions. No DOM, no globals.

function cell(v) {
  return v == null ? '' : String(v);
}

/**
 * TabSeparated text: a header row of column names + one line per data row.
 * Backslashes, tabs and newlines are escaped ClickHouse-TSV style so embedded
 * whitespace can't break the column/row grid when pasted. `nullText` is emitted
 * verbatim for null/undefined cells — '' (default) for Copy, or '\N' for the TSV
 * result view so it mirrors `FORMAT TabSeparatedWithNames`.
 */
export function toTSV(columns, rows, nullText = '') {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const tsvCell = (v) => (v == null ? nullText : esc(String(v)));
  const head = columns.map((c) => esc(c.name)).join('\t');
  const body = rows.map((row) => row.map(tsvCell).join('\t')).join('\n');
  return rows.length ? head + '\n' + body : head;
}

/**
 * RFC-4180 CSV: a header row + one line per data row. A field is quoted only
 * when it contains a comma, double-quote, or CR/LF; internal quotes are doubled.
 */
export function toCSV(columns, rows) {
  const q = (s) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const head = columns.map((c) => q(c.name)).join(',');
  const body = rows.map((row) => row.map((v) => q(cell(v))).join(',')).join('\n');
  return rows.length ? head + '\n' + body : head;
}
