// Pure formatting + small string helpers. No DOM, no globals — trivially
// unit-testable and shared across the UI layer.

/** Clamp `v` into the inclusive range [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Human-readable row count: 0..999 verbatim, then K/M/B with one decimal of
 * precision for the low end of each band. Returns '—' for null/NaN.
 */
export function formatRows(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + 'B';
}

/** Human-readable byte count (B/KB/MB/GB/TB). Returns '—' for null/NaN. */
export function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n < 1024 ** 4) return (n / 1024 ** 3).toFixed(2) + ' GB';
  return (n / 1024 ** 4).toFixed(2) + ' TB';
}

/**
 * Relative time label ("12s ago", "3m ago", "5h ago", "2d ago").
 * `now` is injectable for deterministic tests.
 */
export function timeAgo(ts, now = Date.now()) {
  const s = (now - ts) / 1000;
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

/** Quote + escape a string as a ClickHouse SQL string literal. */
export function sqlString(s) {
  // Escape the backslash first (CH honors backslash escapes in string literals,
  // so a trailing `\` would otherwise escape the closing quote and break out),
  // then double the single quote.
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

/**
 * Derive a short display name for a saved query: "Query · <table>" when a
 * FROM clause is present, else the first 48 chars of the collapsed SQL.
 */
export function inferQueryName(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const m = /\bFROM\s+([A-Za-z_][\w.`"]*)/i.exec(s);
  if (m) return 'Query · ' + m[1].replace(/[`"]/g, '');
  return s.length > 48 ? s.slice(0, 45) + '…' : s;
}

/** True for ClickHouse numeric column types (Int/UInt/Float/Decimal). */
export function isNumericType(type) {
  return /^(U?Int|Float|Decimal)/.test(type || '');
}

/**
 * Short form of a ClickHouse version for the header: the first three
 * dot-segments (e.g. '26.3.10.20001.altinityantalya' → '26.3.10'). The full
 * string is shown on hover. Empty/short inputs pass through unchanged.
 */
export function shortVersion(v) {
  const parts = String(v || '').split('.');
  return parts.length > 3 ? parts.slice(0, 3).join('.') : String(v || '');
}
