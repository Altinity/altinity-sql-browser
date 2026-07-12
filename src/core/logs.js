// Pure helpers for the dashboard's logs tile view (#149 D9). No DOM, no
// globals. A fallback (non-chartable, not saved `view:'table'`) tile result
// qualifies as "logs" when it has a DateTime-ish column plus a String message
// column; an optional level column drives per-row colors. Detection is a
// name+type heuristic over the *stripped* column types (reusing
// `chartStripType` for `Nullable(...)`/`LowCardinality(...)` unwrapping) —
// an explicit saved table choice bypasses it upstream.

import { chartStripType } from './chart-data.js';
import { truncate } from './format.js';

// Stripped-type gates. Time requires a time-of-day, so plain `Date` is
// excluded; the `(\(|$)` tail accepts parameterized forms — `DateTime('UTC')`,
// `DateTime64(9, 'UTC')` — without matching an unrelated `DateTime...` name.
const TIME_TYPE_RE = /^DateTime(64)?(\(|$)/;
const MSG_TYPE_RE = /^(String|FixedString)/;
const LEVEL_TYPE_RE = /^(String|FixedString|Enum8|Enum16)/;

// Name conventions (matched case-insensitively). Covers `system.text_log`
// (event_time/level/message), OTel log tables (Timestamp/SeverityText/Body —
// 'severitytext' is that CamelCase name lowercased), and typical app tables.
const MSG_NAMES = new Set(['message', 'msg', 'body', 'log', 'line']);
const LEVEL_NAMES = new Set(['level', 'severity', 'log_level', 'loglevel', 'severity_text', 'severitytext']);

// Per-role convention scanners (first match by position, -1 when absent).
// Exported so panel-cfg's name-based logs arm (#166) can fall back per role —
// an explicit `msg` name may pair with a convention-detected time column.
export function findTimeColumn(columns) {
  return (columns || []).findIndex((c) => TIME_TYPE_RE.test(chartStripType(c.type)));
}
export function findMsgColumn(columns) {
  return (columns || []).findIndex((c) =>
    MSG_NAMES.has(String(c.name).toLowerCase()) && MSG_TYPE_RE.test(chartStripType(c.type)));
}
export function findLevelColumn(columns) {
  return (columns || []).findIndex((c) =>
    LEVEL_NAMES.has(String(c.name).toLowerCase()) && LEVEL_TYPE_RE.test(chartStripType(c.type)));
}

/**
 * Detect a log-shaped result from its columns: the first (by position)
 * DateTime/DateTime64 column is the time, the first String-ish column with a
 * message-like name is the message, and an optional String/Enum column with a
 * level-like name colors the rows. Everything else lands in `extras` (query
 * order) and renders as dimmed key=value pairs after the message.
 * Returns `{time, msg, level|null, extras: idx[]}` or null when either
 * required part (time, message) is missing.
 */
export function detectLogsView(columns) {
  const cols = columns || [];
  const time = findTimeColumn(cols);
  if (time < 0) return null;
  const msg = findMsgColumn(cols);
  if (msg < 0) return null;
  const found = findLevelColumn(cols);
  const level = found < 0 ? null : found;
  const extras = cols.map((_, i) => i).filter((i) => i !== time && i !== msg && i !== level);
  return { time, msg, level, extras };
}

// Level aliases → the six color classes. Covers ClickHouse's own text_log
// Enum ('Fatal'..'Test'), syslog names (emerg/alert/crit/err/notice), and the
// common warn/info/verbose shorthands.
const LEVEL_ALIASES = {
  fatal: 'fatal', critical: 'fatal', crit: 'fatal', emerg: 'fatal', emergency: 'fatal', alert: 'fatal',
  error: 'error', err: 'error',
  warning: 'warn', warn: 'warn',
  info: 'info', information: 'info', informational: 'info', notice: 'info',
  debug: 'debug',
  trace: 'trace', test: 'trace', verbose: 'trace',
};

/**
 * Map a level value to its color class: 'fatal'|'error'|'warn'|'info'|
 * 'debug'|'trace', or '' for unknown/null (rows render uncolored, never throw).
 * Case-insensitive. Own-property lookup: level values are arbitrary server
 * data, and a bare index would leak inherited Object.prototype members
 * ('constructor', '__proto__') into the row's class list.
 */
export function logLevelClass(value) {
  const key = value == null ? '' : String(value).toLowerCase();
  return Object.hasOwn(LEVEL_ALIASES, key) ? LEVEL_ALIASES[key] : '';
}

/**
 * Compact a log timestamp for display: fractional seconds trimmed to ms
 * (`DateTime64(9)`'s nanoseconds are noise at reading density). Null-safe → ''.
 */
export function formatLogTime(v) {
  return v == null ? '' : String(v).replace(/(\.\d{3})\d+$/, '$1');
}

/**
 * Shape one result row for the logs renderer:
 * `{time, level, levelClass, msg, extras:[{name, value}]}`.
 * `level` is '' when the shape has no level column (or its value is null).
 * Extras skip null/'' values; object/array values (OTel map/array attributes)
 * get compact `JSON.stringify` — `String(v)` would yield `[object Object]` —
 * then everything is truncated to 80 chars.
 */
export function logRowDisplay(columns, row, shape) {
  const rawLevel = shape.level == null ? null : row[shape.level];
  const extras = [];
  for (const i of shape.extras) {
    const v = row[i];
    if (v == null || v === '') continue;
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    extras.push({ name: columns[i].name, value: truncate(str, 80) });
  }
  return {
    time: formatLogTime(row[shape.time]),
    level: rawLevel == null ? '' : String(rawLevel),
    levelClass: logLevelClass(rawLevel),
    msg: row[shape.msg] == null ? '' : String(row[shape.msg]),
    extras,
  };
}
