import { describe, it, expect } from 'vitest';
import { detectLogsView, logLevelClass, formatLogTime, logRowDisplay } from '../../src/core/logs.js';
import { renderLogs } from '../../src/ui/logs.js';

// ── core/logs.js ─────────────────────────────────────────────────────────────
describe('detectLogsView', () => {
  it('detects the system.text_log shape (time + level + message)', () => {
    const shape = detectLogsView([
      { name: 'event_time', type: 'DateTime' },
      { name: 'level', type: "Enum8('Fatal' = 1, 'Error' = 4, 'Information' = 7)" },
      { name: 'message', type: 'String' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 2, level: 1, extras: [] });
  });
  it('level is optional — time + message alone qualify, level null', () => {
    const shape = detectLogsView([
      { name: 'ts', type: 'DateTime' },
      { name: 'msg', type: 'String' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 1, level: null, extras: [] });
  });
  it('missing time or missing message → null (and no columns at all → null)', () => {
    expect(detectLogsView([{ name: 'message', type: 'String' }])).toBeNull();
    expect(detectLogsView([{ name: 'ts', type: 'DateTime' }, { name: 'host', type: 'String' }])).toBeNull();
    expect(detectLogsView(undefined)).toBeNull();
  });
  it('strips nested Nullable(LowCardinality(...)) wrappers before the type check', () => {
    const shape = detectLogsView([
      { name: 'ts', type: 'Nullable(DateTime)' },
      { name: 'body', type: 'Nullable(LowCardinality(String))' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 1, level: null, extras: [] });
  });
  it('accepts parameterized types: DateTime64(9, timezone), DateTime(timezone), FixedString, Enum8', () => {
    const shape = detectLogsView([
      { name: 'ts', type: "DateTime64(9, 'UTC')" },
      { name: 'severity', type: "Enum8('Info' = 1, 'Warn' = 2)" },
      { name: 'line', type: 'FixedString(64)' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 2, level: 1, extras: [] });
    expect(detectLogsView([
      { name: 'ts', type: "DateTime('UTC')" },
      { name: 'log', type: 'String' },
    ])).toEqual({ time: 0, msg: 1, level: null, extras: [] });
  });
  it('matches names case-insensitively (OTel Timestamp/SeverityText/Body)', () => {
    const shape = detectLogsView([
      { name: 'Timestamp', type: 'DateTime64(9)' },
      { name: 'SeverityText', type: 'LowCardinality(String)' },
      { name: 'Body', type: 'String' },
      { name: 'TraceId', type: 'String' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 2, level: 1, extras: [3] });
  });
  it('rejects a message-named column of numeric type', () => {
    expect(detectLogsView([
      { name: 'ts', type: 'DateTime' },
      { name: 'message', type: 'UInt64' },
    ])).toBeNull();
  });
  it('ignores a level-named column of numeric type (colors off, still logs)', () => {
    const shape = detectLogsView([
      { name: 'ts', type: 'DateTime' },
      { name: 'level', type: 'UInt8' },
      { name: 'message', type: 'String' },
    ]);
    expect(shape).toEqual({ time: 0, msg: 2, level: null, extras: [1] });
  });
  it('excludes plain Date as the time column', () => {
    expect(detectLogsView([
      { name: 'day', type: 'Date' },
      { name: 'message', type: 'String' },
    ])).toBeNull();
  });
  it('collects every non-time/msg/level column as extras, in query order', () => {
    const shape = detectLogsView([
      { name: 'host', type: 'String' },
      { name: 'event_time', type: 'DateTime' },
      { name: 'severity_text', type: 'String' },
      { name: 'message', type: 'String' },
      { name: 'count', type: 'UInt64' },
    ]);
    expect(shape).toEqual({ time: 1, msg: 3, level: 2, extras: [0, 4] });
  });
});

describe('logLevelClass', () => {
  it('maps the full alias table, case-insensitively', () => {
    const table = {
      fatal: 'fatal', critical: 'fatal', crit: 'fatal', emerg: 'fatal', emergency: 'fatal', alert: 'fatal',
      error: 'error', err: 'error',
      warning: 'warn', warn: 'warn',
      info: 'info', information: 'info', informational: 'info', notice: 'info',
      debug: 'debug',
      trace: 'trace', test: 'trace', verbose: 'trace',
    };
    for (const [alias, cls] of Object.entries(table)) {
      expect(logLevelClass(alias)).toBe(cls);
      expect(logLevelClass(alias.toUpperCase())).toBe(cls);
    }
    expect(logLevelClass('Test')).toBe('trace'); // ClickHouse text_log enum value
  });
  it("unknown and null are '' (never throws)", () => {
    expect(logLevelClass('shiny')).toBe('');
    expect(logLevelClass(null)).toBe('');
    expect(logLevelClass(undefined)).toBe('');
  });
  it("inherited Object.prototype keys don't leak through the alias table", () => {
    expect(logLevelClass('constructor')).toBe('');
    expect(logLevelClass('__proto__')).toBe('');
    expect(logLevelClass('hasOwnProperty')).toBe('');
  });
});

describe('formatLogTime', () => {
  it('trims fractional seconds to milliseconds', () => {
    expect(formatLogTime('2026-07-10 12:00:00.123456789')).toBe('2026-07-10 12:00:00.123');
    expect(formatLogTime('2026-07-10 12:00:00.123')).toBe('2026-07-10 12:00:00.123');
    expect(formatLogTime('2026-07-10 12:00:00')).toBe('2026-07-10 12:00:00');
  });
  it("null-safe → ''", () => {
    expect(formatLogTime(null)).toBe('');
  });
});

describe('logRowDisplay', () => {
  const columns = [
    { name: 'ts', type: 'DateTime64(9)' },
    { name: 'level', type: 'String' },
    { name: 'message', type: 'String' },
    { name: 'host', type: 'String' },
    { name: 'attrs', type: 'Map(String, String)' },
  ];
  const shape = { time: 0, msg: 2, level: 1, extras: [3, 4] };

  it('shapes time/level/msg and skips null/empty extras', () => {
    const d = logRowDisplay(columns, ['2026-07-10 12:00:00.123456789', 'Error', 'boom', '', null], shape);
    expect(d.time).toBe('2026-07-10 12:00:00.123');
    expect(d.level).toBe('Error');
    expect(d.levelClass).toBe('error');
    expect(d.msg).toBe('boom');
    expect(d.extras).toEqual([]);
  });
  it('object/array extras get compact JSON (not [object Object]), truncated to 80 chars', () => {
    const d = logRowDisplay(columns, ['t', 'Info', 'm', ['a', 'b'], { k: 'v' }], shape);
    expect(d.extras).toEqual([
      { name: 'host', value: '["a","b"]' },
      { name: 'attrs', value: '{"k":"v"}' },
    ]);
    const long = logRowDisplay(columns, ['t', 'Info', 'm', 'x'.repeat(200), null], shape);
    expect(long.extras[0].value).toHaveLength(80);
    expect(long.extras[0].value.endsWith('…')).toBe(true);
  });
  it('stringifies scalar extras', () => {
    const d = logRowDisplay(columns, ['t', 'Info', 'm', null, 42], shape);
    expect(d.extras).toEqual([{ name: 'attrs', value: '42' }]);
  });
  it("null level value and null message → '' (levelClass '')", () => {
    const d = logRowDisplay(columns, ['t', null, null, null, null], shape);
    expect(d.level).toBe('');
    expect(d.levelClass).toBe('');
    expect(d.msg).toBe('');
  });
  it("a no-level shape yields level '' without touching the row", () => {
    const d = logRowDisplay(columns, ['t', 'Error', 'm', null, null], { time: 0, msg: 2, level: null, extras: [] });
    expect(d.level).toBe('');
    expect(d.levelClass).toBe('');
    expect(d.extras).toEqual([]);
  });
});

// ── ui/logs.js ───────────────────────────────────────────────────────────────
describe('renderLogs', () => {
  const columns = [
    { name: 'ts', type: 'DateTime' },
    { name: 'level', type: 'String' },
    { name: 'message', type: 'String' },
    { name: 'host', type: 'String' },
  ];
  const shape = { time: 0, msg: 2, level: 1, extras: [3] };

  it('renders one row per result row with per-level classes, level/extras spans', () => {
    const el = renderLogs({
      columns,
      rows: [
        ['2026-07-10 12:00:00', 'Error', 'boom', 'web-1'],
        ['2026-07-10 12:00:01', 'Warning', 'careful', null],
        ['2026-07-10 12:00:02', 'shiny', 'unknown level', null],
      ],
      shape,
      cap: 100,
    });
    expect(el.className).toBe('dash-logs');
    const rows = el.querySelectorAll('.log-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].className).toBe('log-row log-error');
    expect(rows[1].className).toBe('log-row log-warn');
    expect(rows[2].className).toBe('log-row'); // unknown level → no color class
    expect(rows[0].querySelector('.log-time').textContent).toBe('2026-07-10 12:00:00');
    expect(rows[0].querySelector('.log-level').textContent).toBe('Error');
    expect(rows[0].querySelector('.log-msg').textContent).toBe('boom');
    expect(rows[0].querySelector('.log-extras').textContent).toBe('host=web-1');
    expect(rows[1].querySelector('.log-extras')).toBeNull(); // no extras → span omitted
  });
  it('omits the .log-level span entirely when the shape has no level column', () => {
    const el = renderLogs({
      columns,
      rows: [['t', 'Error', 'm', null]],
      shape: { time: 0, msg: 2, level: null, extras: [] },
      cap: 100,
    });
    expect(el.querySelector('.log-level')).toBeNull();
    expect(el.querySelector('.log-msg').textContent).toBe('m');
  });
  it('preserves query order verbatim (no sorting)', () => {
    const el = renderLogs({
      columns,
      rows: [['t3', 'Info', 'third', null], ['t1', 'Info', 'first', null], ['t2', 'Info', 'second', null]],
      shape,
      cap: 100,
    });
    const msgs = [...el.querySelectorAll('.log-msg')].map((s) => s.textContent);
    expect(msgs).toEqual(['third', 'first', 'second']);
  });
  it('caps the rendered rows and appends the in-body truncation footer', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ['t', 'Info', 'm' + i, null]);
    const el = renderLogs({ columns, rows, shape, cap: 3 });
    expect(el.querySelectorAll('.log-row')).toHaveLength(3);
    expect(el.textContent).toContain('… + 2 more rows truncated for display.');
  });
  it('renders no footer when rows fit the cap', () => {
    const el = renderLogs({ columns, rows: [['t', 'Info', 'm', null]], shape, cap: 3 });
    expect(el.textContent).not.toContain('truncated for display');
  });
});
