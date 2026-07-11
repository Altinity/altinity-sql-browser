// Relative time expressions for date/time-typed `{name:Type}` variables (#169)
// — Grafana's grammar (`now`, `-1h`, `now/d`, …) adopted verbatim, including
// case-sensitive units and round-down semantics. Pure: the caller supplies
// `nowMs` (a wall-clock epoch reading) — this module never reads the clock
// itself. `Date` *construction* from a supplied ms value is fine (that's just
// arithmetic); only wall-clock READS are banned, per the repo's keystroke rule.
//
// expr := 'now' [sign amount unit] [rounding]
//       | sign amount unit [rounding]        -- shorthand: '-1h' ≡ 'now-1h'
// sign := '-' | '+'
// unit := s | m | h | d | w | M | y          -- m = minute, M = month (case-sensitive)
// rounding := '/' unit                        -- always snaps DOWN, applied AFTER the offset
//
// Duration vs. calendar arithmetic (pinned — matters across DST): s/m/h
// offsets are FIXED DURATIONS (exact milliseconds on the epoch timeline); d/w/M/y
// offsets, and ALL `/u` rounding regardless of unit, are CALENDAR arithmetic in
// the LOCAL timezone (the runtime's `Date` local getters/setters — the
// browser's zone in production, `TZ` in tests) — so `-1d` means "the same
// wall-clock time yesterday" even when that is 23 or 25 elapsed hours across a
// DST transition, and `now/d` is local midnight even on a transition day.
// Month/year offsets clamp the day-of-month to the target month's last day
// (`Mar 31 -1M` → Feb 28/29), matching ClickHouse's `date_sub` semantics.
// Weeks start Monday (ISO-8601).
//
// Anything that doesn't match the grammar at all is passed through verbatim
// (an absolute value keeps working unchanged) — except a string that *looks*
// like it's trying to be relative (starts with 'now', or a sign followed by a
// digit) but fails to fully parse: that's flagged as a structured error, never
// silently passed through and never sent.

import { parseParamType } from './param-type.js';

const MS_PER_UNIT = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };
const FIXED_UNITS = new Set(['s', 'm', 'h']);
const UNIT_CLASS = '[smhdwMy]';
const RE_NOW = new RegExp(`^now(?:([+-])(\\d+)(${UNIT_CLASS}))?(?:/(${UNIT_CLASS}))?$`);
const RE_SHORTHAND = new RegExp(`^([+-])(\\d+)(${UNIT_CLASS})(?:/(${UNIT_CLASS}))?$`);
const UNIT_LABEL = 's, m, h, d, w, M, y';

// ── Grammar parse ────────────────────────────────────────────────────────

/**
 * Parse a relative-time expression's grammar (no clock, no formatting).
 * @param {string} expr
 * @returns {{offset: {sign: 1|-1, amount: number, unit: string}|null,
 *            round: string|null}|null|{error: string}}
 *   `null` — not a relative expression at all (rule 6: absolute passthrough).
 *   `{error}` — looked relative (starts `now`, or sign+digit) but failed to
 *   fully parse.
 *   Otherwise the parsed `{offset, round}` shape (either may be null).
 */
export function parseRelativeExpr(expr) {
  const s = String(expr);
  let m = RE_NOW.exec(s);
  if (m) {
    return {
      offset: m[1] ? { sign: m[1] === '-' ? -1 : 1, amount: Number(m[2]), unit: m[3] } : null,
      round: m[4] || null,
    };
  }
  m = RE_SHORTHAND.exec(s);
  if (m) {
    return {
      offset: { sign: m[1] === '-' ? -1 : 1, amount: Number(m[2]), unit: m[3] },
      round: m[4] || null,
    };
  }
  if (/^now/.test(s) || /^[+-]\d/.test(s)) {
    return { error: `Not a valid relative time expression: "${s}" (expected now, ±Nu, or /u — u = ${UNIT_LABEL})` };
  }
  return null;
}

// ── Calendar arithmetic (local timezone) ─────────────────────────────────

function daysInMonth(year, month0 /* 0-indexed */) {
  return new Date(year, month0 + 1, 0).getDate();
}

// Add a calendar offset (d/w/M/y) to `epochMs`, reconstructing local
// components so the result keeps the same wall-clock time-of-day — the
// DST-safe "same time yesterday" behavior — with month/year offsets clamped
// to the target month's last day.
function addCalendarOffset(epochMs, sign, amount, unit) {
  const d = new Date(epochMs);
  const y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const h = d.getHours(), mi = d.getMinutes(), se = d.getSeconds(), ms = d.getMilliseconds();
  if (unit === 'd') return new Date(y, mo, day + sign * amount, h, mi, se, ms).getTime();
  if (unit === 'w') return new Date(y, mo, day + sign * amount * 7, h, mi, se, ms).getTime();
  if (unit === 'M') {
    const total = mo + sign * amount;
    const ty = y + Math.floor(total / 12);
    const tm = ((total % 12) + 12) % 12;
    return new Date(ty, tm, Math.min(day, daysInMonth(ty, tm)), h, mi, se, ms).getTime();
  }
  // unit === 'y'
  const ty = y + sign * amount;
  return new Date(ty, mo, Math.min(day, daysInMonth(ty, mo)), h, mi, se, ms).getTime();
}

function applyOffset(epochMs, offset) {
  if (!offset) return epochMs;
  const { sign, amount, unit } = offset;
  if (FIXED_UNITS.has(unit)) return epochMs + sign * amount * MS_PER_UNIT[unit];
  return addCalendarOffset(epochMs, sign, amount, unit);
}

// Snap `epochMs` DOWN to the start of `unit`, in local time. ISO weeks start
// Monday: `getDay()` is 0=Sun..6=Sat, so `(dow + 6) % 7` is the day count
// since the most recent Monday.
function roundDown(epochMs, unit) {
  const d = new Date(epochMs);
  const y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const h = d.getHours(), mi = d.getMinutes(), se = d.getSeconds();
  switch (unit) {
    case 's': return new Date(y, mo, day, h, mi, se, 0).getTime();
    case 'm': return new Date(y, mo, day, h, mi, 0, 0).getTime();
    case 'h': return new Date(y, mo, day, h, 0, 0, 0).getTime();
    case 'd': return new Date(y, mo, day, 0, 0, 0, 0).getTime();
    case 'w': return new Date(y, mo, day - ((d.getDay() + 6) % 7), 0, 0, 0, 0).getTime();
    case 'M': return new Date(y, mo, 1, 0, 0, 0, 0).getTime();
    default: return new Date(y, 0, 1, 0, 0, 0, 0).getTime(); // 'y'
  }
}

/**
 * Resolve a parsed `{offset, round}` shape against `nowMs` to a final epoch
 * ms instant: offset first, then rounding (rule 2). Pure.
 */
export function resolveInstant(parsed, nowMs) {
  const afterOffset = applyOffset(nowMs, parsed.offset);
  return parsed.round ? roundDown(afterOffset, parsed.round) : afterOffset;
}

// ── Per-declared-type formatting ─────────────────────────────────────────

const pad = (n, w) => String(n).padStart(w, '0');

function formatDate(epochMs) {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

// Integer epoch seconds only (fractional is rejected by the param path for
// plain DateTime — live-verified against ClickHouse 26.3.13). FLOORED, never
// rounded (review finding #3): `Math.round` could push a resolved instant a
// second into the future, and disagreed with `formatDateTime64`'s floor for
// DateTime64(0) on the very same instant whenever the sub-second remainder
// was ≥500ms — floor keeps both representations of one instant in agreement
// and never reports a time later than the instant actually is.
function formatDateTimeSeconds(epochMs) {
  return String(Math.floor(epochMs / 1000));
}

// Epoch seconds with exactly `n` fraction digits: the first 3 come from the
// browser clock's real millisecond remainder (floor-division, so it's always
// in [0,1000) even for a negative epoch), any digits beyond that are
// zero-filled — a relative expression never claims sub-ms precision it
// doesn't have (live-verified: DateTime64(3)/(6) both accept this shape,
// trailing zeros included).
function formatDateTime64(epochMs, n) {
  const wholeSec = Math.floor(epochMs / 1000);
  if (n <= 0) return String(wholeSec);
  const msRemainder = epochMs - wholeSec * 1000;
  const frac = (pad(msRemainder, 3) + '0'.repeat(Math.max(0, n - 3))).slice(0, n);
  return `${wholeSec}.${frac}`;
}

function parsedType(type) {
  return typeof type === 'string' ? parseParamType(type) : type;
}

/**
 * Is this declared parameter type date-like (`Date`, `Date32`, `DateTime`,
 * `DateTime64(N)`, any `Nullable(...)`-wrapped)? `parseParamType` already
 * unwraps `Nullable` for free. Pure.
 * @param {string|import('./param-type.js').ParsedParamType} type
 */
export function isDateLikeType(type) {
  const base = parsedType(type).base;
  return base === 'Date' || base === 'Date32' || base === 'DateTime' || base === 'DateTime64';
}

function formatByType(epochMs, t) {
  if (t.base === 'Date' || t.base === 'Date32') return formatDate(epochMs);
  if (t.base === 'DateTime64') {
    const n = t.inner ? parseInt(t.inner, 10) || 0 : 0;
    return formatDateTime64(epochMs, n);
  }
  return formatDateTimeSeconds(epochMs); // 'DateTime' (with or without a tz arg)
}

// ── Human-readable preview formatting (review finding #1) ────────────────
//
// The live preview shown next to the field must read as a calendar instant
// ("2026-07-11 09:23:45"), never the wire value ("1783772625") the field
// actually transports — those diverge for every date-like type except
// `Date`/`Date32`. This is presentation only: `formatByType` above still owns
// what gets sent. Local time (the browser's zone), floored to the whole
// second (finding #3 — never rounds into the future), with a fractional
// suffix only for `DateTime64(N>0)` and only when the remainder is non-zero
// — a preview showing ".000" on every value would be more noise than signal.
function formatPreviewInstant(epochMs, t) {
  if (t.base === 'Date' || t.base === 'Date32') return formatDate(epochMs);
  const d = new Date(Math.floor(epochMs / 1000) * 1000);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} `
    + `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
  if (t.base === 'DateTime64') {
    const n = t.inner ? parseInt(t.inner, 10) || 0 : 0;
    if (n > 0) {
      const wholeSec = Math.floor(epochMs / 1000);
      const msRemainder = epochMs - wholeSec * 1000;
      if (msRemainder !== 0) {
        const frac = (pad(msRemainder, 3) + '0'.repeat(Math.max(0, n - 3))).slice(0, n);
        return `${base}.${frac}`;
      }
    }
  }
  return base;
}

/**
 * Resolve a variable's entered text against its declared type and a pinned
 * wall clock: `-1h` → a formatted literal ready for `param_<name>`. Pure, no
 * `Date.now()` inside.
 * @param {string} expr the field's current text
 * @param {string|import('./param-type.js').ParsedParamType} type the declared `{name:Type}`
 * @param {number} nowMs the wave's pinned wall clock (epoch ms)
 * @returns {{ok: true, value: string, matched: boolean}|{ok: false, error: string}}
 *   `matched` is true only when `expr` actually matched the relative grammar
 *   (as opposed to being an absolute value passed through verbatim) — the
 *   live-preview UI uses it to decide whether there's anything to show.
 */
export function resolveRelativeValue(expr, type, nowMs) {
  const t = parsedType(type);
  if (!isDateLikeType(t)) return { ok: true, value: expr, matched: false };
  const parsed = parseRelativeExpr(expr);
  if (parsed == null) return { ok: true, value: expr, matched: false };
  if (parsed.error) return { ok: false, error: parsed.error };
  const instant = resolveInstant(parsed, nowMs);
  return { ok: true, value: formatByType(instant, t), matched: true };
}

/**
 * The live-preview seam (review finding #1): resolve `expr` exactly like
 * `resolveRelativeValue`, but format the resolved instant as a **human-
 * readable local calendar string** (`YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DD` for
 * `Date`/`Date32`) instead of the wire value — the wire value (epoch seconds
 * for `DateTime`/`DateTime64`) is what actually gets sent; this is display
 * only. Pure.
 * @param {string} expr
 * @param {string|import('./param-type.js').ParsedParamType} type
 * @param {number} nowMs
 * @returns {{ok: true, display: string, matched: boolean}|{ok: false, error: string}}
 */
export function formatPreview(expr, type, nowMs) {
  const t = parsedType(type);
  if (!isDateLikeType(t)) return { ok: true, display: expr, matched: false };
  const parsed = parseRelativeExpr(expr);
  if (parsed == null) return { ok: true, display: expr, matched: false };
  if (parsed.error) return { ok: false, error: parsed.error };
  const instant = resolveInstant(parsed, nowMs);
  return { ok: true, display: formatPreviewInstant(instant, t), matched: true };
}

/**
 * Batch helper: resolve every `{name, type}` param's stored value against
 * `nowMs`, one call. Empty/missing values pass through as an unmatched `ok`
 * result (their own gating — missing/inactive — is the caller's business, not
 * this module's). Pure.
 * @param {{name: string, type: string}[]} params
 * @param {Object<string, string>} values
 * @param {number} nowMs
 */
export function resolveVarValues(params, values, nowMs) {
  const out = {};
  for (const p of params || []) {
    const raw = values ? values[p.name] : undefined;
    out[p.name] = (raw == null || raw === '')
      ? { ok: true, value: raw, matched: false }
      : resolveRelativeValue(raw, p.type, nowMs);
  }
  return out;
}
