// #169 relative-time grammar/resolution tests. `resolveInstant`'s calendar
// arithmetic (d/w/M/y offsets, all `/u` rounding) uses the RUNTIME's local
// `Date` — there's no per-call timezone injection (the spec is "the browser's
// own zone"), so exercising a specific DST transition deterministically
// requires the *process* to actually be running in a known zone.
//
// Two mechanisms were tried and rejected before this one:
//  - a top-level `process.env.TZ = '...'` in this file — V8/ICU resolve and
//    cache the default timezone per-isolate on first use, and vitest's
//    `threads` pool (tests/vitest.config.ts) reuses worker threads across
//    test files, so by the time this file's code runs the isolate's zone may
//    already be cached from an earlier file. Verified: this left
//    `Intl.DateTimeFormat().resolvedOptions().timeZone` unchanged.
//  - vitest's `test.env` config option — same failure, for the same reason
//    (it also just assigns `process.env` inside an already-running worker).
// Only setting `TZ` in the OS environment *before the process starts*
// reliably works (verified: `TZ=America/New_York npx vitest run …` resolves
// correctly). So `package.json`'s `test`/`test:watch` scripts pin
// `TZ=America/New_York` — chosen because it observes DST (unlike UTC, which
// would make the DST assertions below vacuous) and its 2026 transitions
// (spring-forward 2026-03-08 02:00→03:00, fall-back 2026-11-01 02:00→01:00)
// are exercised directly. The guard below fails loudly, with a clear reason,
// if that pin ever stops taking effect (e.g. someone runs this file directly
// via `npx vitest` without the package.json wrapper).
import { describe, it, expect } from 'vitest';
import {
  parseRelativeExpr,
  resolveInstant,
  resolveRelativeValue,
  formatPreview,
  isDateLikeType,
  resolveVarValues,
} from '../../src/core/relative-time.js';

it('test runner TZ guard: this file requires TZ=America/New_York (see package.json scripts)', () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
});

const ms = (y, mo, d, h = 0, mi = 0, s = 0, msec = 0) => new Date(y, mo, d, h, mi, s, msec).getTime();

describe('parseRelativeExpr — grammar', () => {
  it('bare "now"', () => {
    expect(parseRelativeExpr('now')).toEqual({ offset: null, round: null });
  });
  it('shorthand offset ("-1h" ≡ "now-1h")', () => {
    expect(parseRelativeExpr('-1h')).toEqual({ offset: { sign: -1, amount: 1, unit: 'h' }, round: null });
    expect(parseRelativeExpr('now-1h')).toEqual({ offset: { sign: -1, amount: 1, unit: 'h' }, round: null });
  });
  it('+ sign', () => {
    expect(parseRelativeExpr('+5m')).toEqual({ offset: { sign: 1, amount: 5, unit: 'm' }, round: null });
    expect(parseRelativeExpr('now+5m')).toEqual({ offset: { sign: 1, amount: 5, unit: 'm' }, round: null });
  });
  it('every unit, offset only', () => {
    for (const unit of ['s', 'm', 'h', 'd', 'w', 'M', 'y']) {
      expect(parseRelativeExpr(`-1${unit}`)).toEqual({ offset: { sign: -1, amount: 1, unit }, round: null });
    }
  });
  it('m (minute) vs M (month) are case-sensitively distinct', () => {
    expect(parseRelativeExpr('-1m')).toEqual({ offset: { sign: -1, amount: 1, unit: 'm' }, round: null });
    expect(parseRelativeExpr('-1M')).toEqual({ offset: { sign: -1, amount: 1, unit: 'M' }, round: null });
  });
  it('rounding alone ("now/u"), every unit', () => {
    for (const unit of ['s', 'm', 'h', 'd', 'w', 'M', 'y']) {
      expect(parseRelativeExpr(`now/${unit}`)).toEqual({ offset: null, round: unit });
    }
  });
  it('offset + rounding, order preserved in the parsed shape ("now-1h/h", "-1d/d")', () => {
    expect(parseRelativeExpr('now-1h/h')).toEqual({ offset: { sign: -1, amount: 1, unit: 'h' }, round: 'h' });
    expect(parseRelativeExpr('-1d/d')).toEqual({ offset: { sign: -1, amount: 1, unit: 'd' }, round: 'd' });
  });
  it('multi-digit amounts', () => {
    expect(parseRelativeExpr('-15m')).toEqual({ offset: { sign: -1, amount: 15, unit: 'm' }, round: null });
  });
  it('absolute values pass through as null (not relative at all)', () => {
    expect(parseRelativeExpr('2026-07-11 09:00:00')).toBeNull();
    expect(parseRelativeExpr('1752220800')).toBeNull();
    expect(parseRelativeExpr('')).toBeNull();
  });
  it('near-miss strings starting "now" fail with a structured error', () => {
    expect(parseRelativeExpr('now/q').error).toMatch(/Not a valid relative time expression/);
    expect(parseRelativeExpr('nowbogus').error).toBeTruthy();
    expect(parseRelativeExpr('now-1x').error).toBeTruthy();
    expect(parseRelativeExpr('now-1h/q').error).toBeTruthy();
  });
  it('near-miss strings shaped sign+digits+letters fail with a structured error', () => {
    expect(parseRelativeExpr('-5x').error).toBeTruthy();
    expect(parseRelativeExpr('-1hfoo').error).toBeTruthy();
    expect(parseRelativeExpr('-1h/q').error).toBeTruthy();
  });
  it('a lone sign+digit with no unit is a near-miss error, not a passthrough', () => {
    expect(parseRelativeExpr('-5').error).toBeTruthy();
  });
});

describe('resolveInstant — offset/rounding order and calendar arithmetic', () => {
  it('offset-then-round: "now-1h/h" rounds the offset instant, not "now"', () => {
    const now = ms(2026, 6, 11, 14, 45, 30);
    const parsed = parseRelativeExpr('now-1h/h');
    expect(resolveInstant(parsed, now)).toBe(ms(2026, 6, 11, 13, 0, 0));
  });
  it('rounding every unit snaps DOWN', () => {
    const now = ms(2026, 6, 8, 15, 42, 17, 123); // 2026-07-08 is a Wednesday
    expect(resolveInstant(parseRelativeExpr('now/s'), now)).toBe(ms(2026, 6, 8, 15, 42, 17, 0));
    expect(resolveInstant(parseRelativeExpr('now/m'), now)).toBe(ms(2026, 6, 8, 15, 42, 0, 0));
    expect(resolveInstant(parseRelativeExpr('now/h'), now)).toBe(ms(2026, 6, 8, 15, 0, 0, 0));
    expect(resolveInstant(parseRelativeExpr('now/d'), now)).toBe(ms(2026, 6, 8, 0, 0, 0, 0));
    expect(resolveInstant(parseRelativeExpr('now/M'), now)).toBe(ms(2026, 6, 1, 0, 0, 0, 0));
    expect(resolveInstant(parseRelativeExpr('now/y'), now)).toBe(ms(2026, 0, 1, 0, 0, 0, 0));
  });
  it('ISO-Monday week rounding: a Wednesday rounds back to that week\'s Monday', () => {
    const wed = ms(2026, 6, 8, 15, 0, 0, 0); // Wed
    expect(resolveInstant(parseRelativeExpr('now/w'), wed)).toBe(ms(2026, 6, 6, 0, 0, 0, 0)); // Mon
  });
  it('ISO-Monday week rounding: a Sunday rounds back to the PRECEDING Monday (not itself)', () => {
    const sun = ms(2026, 6, 12, 10, 0, 0, 0); // Sun
    expect(resolveInstant(parseRelativeExpr('now/w'), sun)).toBe(ms(2026, 6, 6, 0, 0, 0, 0));
  });
  it('ISO-Monday week rounding: a Monday rounds to itself at midnight', () => {
    const mon = ms(2026, 6, 6, 10, 0, 0, 0);
    expect(resolveInstant(parseRelativeExpr('now/w'), mon)).toBe(ms(2026, 6, 6, 0, 0, 0, 0));
  });
  it('month-end clamping: Mar 31 -1M → Feb 28 (2026 is not a leap year)', () => {
    const now = ms(2026, 2, 31, 10, 0, 0, 0);
    expect(resolveInstant(parseRelativeExpr('-1M'), now)).toBe(ms(2026, 1, 28, 10, 0, 0, 0));
  });
  it('month-end clamping: leap Feb 29 -1y → Feb 28 the following (non-leap) year', () => {
    const leapFeb29 = ms(2028, 1, 29, 10, 0, 0, 0); // 2028 is a leap year
    expect(resolveInstant(parseRelativeExpr('+1y'), leapFeb29)).toBe(ms(2029, 1, 28, 10, 0, 0, 0));
  });
  it('month offset rolls the year over cleanly (no clamping needed)', () => {
    const now = ms(2026, 0, 15, 9, 0, 0, 0); // Jan 15
    expect(resolveInstant(parseRelativeExpr('-1M'), now)).toBe(ms(2025, 11, 15, 9, 0, 0, 0)); // Dec 15, 2025
  });
  it('week offset (multiple weeks)', () => {
    const now = ms(2026, 6, 15, 9, 0, 0, 0);
    expect(resolveInstant(parseRelativeExpr('-2w'), now)).toBe(ms(2026, 6, 1, 9, 0, 0, 0));
  });

  describe('DST spring-forward (America/New_York, 2026-03-08 02:00→03:00)', () => {
    const afterSpring = ms(2026, 2, 8, 3, 30, 0, 0); // 03:30 EDT, post-transition
    it('"-1h" is a FIXED duration: exactly 3,600,000 ms earlier on the epoch timeline', () => {
      expect(resolveInstant(parseRelativeExpr('-1h'), afterSpring)).toBe(afterSpring - 3600000);
    });
    it('"-1d" keeps the same wall-clock time yesterday (23 elapsed hours, not 24)', () => {
      const target = resolveInstant(parseRelativeExpr('-1d'), afterSpring);
      expect(target).toBe(ms(2026, 2, 7, 3, 30, 0, 0));
      expect(afterSpring - target).toBe(23 * 3600 * 1000); // the short DST day
    });
    it('"now/d" is local midnight even on the transition day', () => {
      expect(resolveInstant(parseRelativeExpr('now/d'), afterSpring)).toBe(ms(2026, 2, 8, 0, 0, 0, 0));
    });
    it('"-1d/d" is local midnight of the day before the transition', () => {
      expect(resolveInstant(parseRelativeExpr('-1d/d'), afterSpring)).toBe(ms(2026, 2, 7, 0, 0, 0, 0));
    });
  });

  describe('DST fall-back (America/New_York, 2026-11-01 02:00→01:00)', () => {
    const afterFallback = ms(2026, 10, 1, 3, 30, 0, 0); // 03:30 EST, post both transitions
    it('"-1h" is a FIXED duration: exactly 3,600,000 ms earlier', () => {
      expect(resolveInstant(parseRelativeExpr('-1h'), afterFallback)).toBe(afterFallback - 3600000);
    });
    it('"-1d" keeps the same wall-clock time yesterday (25 elapsed hours, not 24)', () => {
      const target = resolveInstant(parseRelativeExpr('-1d'), afterFallback);
      expect(target).toBe(ms(2026, 9, 31, 3, 30, 0, 0));
      expect(afterFallback - target).toBe(25 * 3600 * 1000); // the long DST day
    });
    it('"now/d" is local midnight on the transition day', () => {
      expect(resolveInstant(parseRelativeExpr('now/d'), afterFallback)).toBe(ms(2026, 10, 1, 0, 0, 0, 0));
    });
  });
});

describe('isDateLikeType', () => {
  it('true for Date/Date32/DateTime/DateTime64, string or parsed form', () => {
    for (const t of ['Date', 'Date32', 'DateTime', "DateTime('UTC')", 'DateTime64(3)']) {
      expect(isDateLikeType(t)).toBe(true);
    }
    expect(isDateLikeType({ base: 'DateTime' })).toBe(true);
  });
  it('Nullable(...) unwraps for free', () => {
    expect(isDateLikeType('Nullable(DateTime)')).toBe(true);
    expect(isDateLikeType('Nullable(Date)')).toBe(true);
  });
  it('false for non-date types, including Array(DateTime)', () => {
    expect(isDateLikeType('String')).toBe(false);
    expect(isDateLikeType('UInt32')).toBe(false);
    expect(isDateLikeType('Array(DateTime)')).toBe(false);
  });
});

describe('resolveRelativeValue — per-type formatting', () => {
  const now = ms(2026, 6, 11, 9, 23, 45, 0); // 2026-07-11 09:23:45 local

  it('Date/Date32 → local calendar date YYYY-MM-DD', () => {
    expect(resolveRelativeValue('now', 'Date', now)).toEqual({ ok: true, value: '2026-07-11', matched: true });
    expect(resolveRelativeValue('-1d', 'Date32', now)).toEqual({ ok: true, value: '2026-07-10', matched: true });
  });
  it('DateTime → integer epoch seconds (no fraction)', () => {
    const r = resolveRelativeValue('now', 'DateTime', now);
    expect(r).toEqual({ ok: true, value: String(Math.floor(now / 1000)), matched: true });
    expect(r.value).not.toContain('.');
  });
  it("DateTime('tz') formats the same as plain DateTime (epoch seconds)", () => {
    const r = resolveRelativeValue('now', "DateTime('Europe/Madrid')", now);
    expect(r.value).toBe(String(Math.floor(now / 1000)));
  });
  it('DateTime64(3) → epoch seconds with exactly 3 fraction digits', () => {
    const withMs = ms(2026, 6, 11, 9, 23, 45, 123);
    const r = resolveRelativeValue('now', 'DateTime64(3)', withMs);
    expect(r.value).toBe(`${Math.floor(withMs / 1000)}.123`);
  });
  it('DateTime64(6) → 6 fraction digits, sub-ms zero-filled', () => {
    const withMs = ms(2026, 6, 11, 9, 23, 45, 123);
    const r = resolveRelativeValue('now', 'DateTime64(6)', withMs);
    expect(r.value).toBe(`${Math.floor(withMs / 1000)}.123000`);
  });
  it('DateTime64(3) with a whole-second instant pads trailing zeros', () => {
    const whole = ms(2026, 6, 11, 9, 23, 45, 0);
    expect(resolveRelativeValue('now', 'DateTime64(3)', whole).value).toBe(`${whole / 1000}.000`);
  });
  it('DateTime64(0) behaves like DateTime: no fraction', () => {
    const r = resolveRelativeValue('now', 'DateTime64(0)', now);
    expect(r.value).toBe(String(Math.floor(now / 1000)));
    expect(r.value).not.toContain('.');
  });
  it('DateTime64 with no inner precision (malformed/opaque) defaults to no fraction', () => {
    const r = resolveRelativeValue('now', 'DateTime64', now);
    expect(r.value).toBe(String(Math.floor(now / 1000)));
  });
  it('Nullable(DateTime) unwraps and formats as DateTime', () => {
    const r = resolveRelativeValue('now', 'Nullable(DateTime)', now);
    expect(r.value).toBe(String(Math.floor(now / 1000)));
  });
  it('Nullable(Date) unwraps and formats as Date', () => {
    expect(resolveRelativeValue('now', 'Nullable(Date)', now).value).toBe('2026-07-11');
  });
  // Review finding #3: DateTime used to round, DateTime64(0) always floored —
  // the same instant could disagree by a whole second (and DateTime could
  // land a second in the future). Both now FLOOR unconditionally.
  it('a sub-second remainder ≥500ms: DateTime and DateTime64(0) agree (both floor, never round up)', () => {
    const withRemainder = ms(2026, 6, 11, 9, 23, 45, 600); // .600s remainder
    const dt = resolveRelativeValue('now', 'DateTime', withRemainder);
    const dt64_0 = resolveRelativeValue('now', 'DateTime64(0)', withRemainder);
    const floored = String(Math.floor(withRemainder / 1000));
    expect(dt.value).toBe(floored);
    expect(dt64_0.value).toBe(floored);
    expect(dt.value).toBe(dt64_0.value);
    // Rounding would have produced floored+1 (a second in the future) — guard
    // against a regression back to Math.round.
    expect(dt.value).not.toBe(String(Math.floor(withRemainder / 1000) + 1));
  });
});

describe('resolveRelativeValue — passthrough / near-miss / non-date', () => {
  it('non-date types are completely untouched, even text shaped like a relative expr', () => {
    expect(resolveRelativeValue('-1h', 'String', 123)).toEqual({ ok: true, value: '-1h', matched: false });
    expect(resolveRelativeValue('42', 'UInt32', 123)).toEqual({ ok: true, value: '42', matched: false });
  });
  it('an absolute value for a date-like type passes through verbatim, unmatched', () => {
    expect(resolveRelativeValue('2026-07-11 09:00:00', 'DateTime', 123))
      .toEqual({ ok: true, value: '2026-07-11 09:00:00', matched: false });
    expect(resolveRelativeValue('2026-07-11', 'Date', 123))
      .toEqual({ ok: true, value: '2026-07-11', matched: false });
  });
  it('near-miss strings are rejected with a structured error, never sent', () => {
    expect(resolveRelativeValue('now/q', 'DateTime', 123)).toEqual({ ok: false, error: expect.any(String) });
    expect(resolveRelativeValue('-5x', 'Date', 123).ok).toBe(false);
  });
});

describe('resolveVarValues — batch helper', () => {
  it('resolves every param against one pinned clock', () => {
    const now = ms(2026, 6, 11, 9, 0, 0, 0);
    const params = [{ name: 'from', type: 'DateTime' }, { name: 'day', type: 'Date' }, { name: 'q', type: 'String' }];
    const values = { from: '-1h', day: 'now', q: 'x' };
    const out = resolveVarValues(params, values, now);
    expect(out.from).toEqual({ ok: true, value: String(Math.floor((now - 3600000) / 1000)), matched: true });
    expect(out.day).toEqual({ ok: true, value: '2026-07-11', matched: true });
    expect(out.q).toEqual({ ok: true, value: 'x', matched: false });
  });
  it('an empty/missing value passes through unmatched without resolving', () => {
    const out = resolveVarValues([{ name: 'from', type: 'DateTime' }], { from: '' }, 123);
    expect(out.from).toEqual({ ok: true, value: '', matched: false });
    const out2 = resolveVarValues([{ name: 'from', type: 'DateTime' }], {}, 123);
    expect(out2.from).toEqual({ ok: true, value: undefined, matched: false });
  });
  it('an empty params list resolves to an empty map', () => {
    expect(resolveVarValues([], {}, 123)).toEqual({});
    expect(resolveVarValues(undefined, {}, 123)).toEqual({});
  });
  it('a missing `values` map (undefined) is tolerated, same as an empty one', () => {
    const out = resolveVarValues([{ name: 'from', type: 'DateTime' }], undefined, 123);
    expect(out.from).toEqual({ ok: true, value: undefined, matched: false });
  });
});

// Review finding #1: the live preview must render the RESOLVED INSTANT as a
// human-readable local calendar string, never the wire value (epoch seconds
// for DateTime/DateTime64) `resolveRelativeValue` produces for transport.
describe('formatPreview — human-readable local-instant preview (review finding #1)', () => {
  const now = ms(2026, 6, 11, 9, 23, 45, 0); // 2026-07-11 09:23:45 local

  it('non-date types pass through untouched, unmatched', () => {
    expect(formatPreview('-1h', 'String', now)).toEqual({ ok: true, display: '-1h', matched: false });
  });
  it('an absolute (non-relative) value for a date-like type passes through verbatim, unmatched', () => {
    expect(formatPreview('2026-07-11 09:00:00', 'DateTime', now))
      .toEqual({ ok: true, display: '2026-07-11 09:00:00', matched: false });
  });
  it('a near-miss expression is rejected with a structured error, exactly like resolveRelativeValue', () => {
    const r = formatPreview('now/q', 'DateTime', now);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Not a valid relative time expression/);
  });
  it('Date/Date32 → local calendar date YYYY-MM-DD (no time-of-day)', () => {
    expect(formatPreview('now', 'Date', now)).toEqual({ ok: true, display: '2026-07-11', matched: true });
    expect(formatPreview('-1d', 'Date32', now).display).toBe('2026-07-10');
  });
  it('DateTime → local calendar datetime, no fraction', () => {
    expect(formatPreview('now', 'DateTime', now)).toEqual({ ok: true, display: '2026-07-11 09:23:45', matched: true });
  });
  it('DateTime64(0) → same as DateTime, no fraction', () => {
    expect(formatPreview('now', 'DateTime64(0)', now).display).toBe('2026-07-11 09:23:45');
  });
  it('DateTime64(N) with a non-zero sub-second remainder appends the fraction', () => {
    const withMs = ms(2026, 6, 11, 9, 23, 45, 123);
    expect(formatPreview('now', 'DateTime64(3)', withMs).display).toBe('2026-07-11 09:23:45.123');
    expect(formatPreview('now', 'DateTime64(6)', withMs).display).toBe('2026-07-11 09:23:45.123000');
  });
  it('DateTime64(N) with a whole-second (zero remainder) instant shows no fraction (kept simple/readable)', () => {
    expect(formatPreview('now', 'DateTime64(3)', now).display).toBe('2026-07-11 09:23:45');
  });
  it('a sub-second remainder floors the whole-second part (never rounds up, finding #3 applies here too)', () => {
    const withRemainder = ms(2026, 6, 11, 9, 23, 45, 600);
    expect(formatPreview('now', 'DateTime', withRemainder).display).toBe('2026-07-11 09:23:45');
  });
  it('DateTime64 with no inner precision (malformed/opaque) defaults to no fraction', () => {
    expect(formatPreview('now', 'DateTime64', now).display).toBe('2026-07-11 09:23:45');
  });
  it('Nullable(DateTime) unwraps and formats as DateTime', () => {
    expect(formatPreview('now', 'Nullable(DateTime)', now).display).toBe('2026-07-11 09:23:45');
  });
});
