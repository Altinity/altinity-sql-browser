// Pure resolution of a compact, stable `{name:Type}` filter/variable input's
// visible width (#345): one width per field for its whole lifetime, selected
// by declared ClickHouse type + control kind, never derived from the current
// value or recomputed on keystroke. Shared by every `{name:Type}` filter
// surface — the workbench var-strip (`src/ui/app.ts`), the Dashboard/detached-
// view shared filter bar (`src/ui/filter-bar.ts`), and its curated single-
// select branch — so none of them can drift out of sync (CLAUDE.md rule 5).
//
// Keyed off the type's EFFECTIVE base (`parseParamType` already unwraps
// `Nullable`/`LowCardinality`), not the field's rendered control kind alone:
// `Date` and `DateTime` share the same relative-time combobox control
// (`isDateLikeType`, param-pipeline.js) but get different widths here, since a
// `DateTime`/relative-time literal ("-1d", "now") is materially longer than a
// bare `Date` one.

import { parseParamType } from './param-type.js';

/** Bool and the single-byte integers — short enough that a couple of digits
 *  or "true"/"false" never need to scroll. */
const BOOL_TINY_INT = /^(Bool|Boolean|U?Int8)$/;
/** Every other numeric base: wider integers, floats, and Decimal (with or
 *  without a bit-width suffix — `Decimal(10, 2)`'s base is bare `Decimal`). */
const NUMERIC_BASE = /^(U?Int(16|32|64|128|256)|Float32|Float64|BFloat16|Decimal(32|64|128|256)?)$/;

/** The width category a `{name:Type}` field resolves to — see the issue's
 *  sizing contract (#345) for the reasoning behind each band. */
export type FilterWidthCategory = 'bool' | 'numeric' | 'date' | 'datetime' | 'enum' | 'string';

// One stable `ch` width per category — each inside the issue's suggested
// band (bool 8–10, numeric 11–13, date 12–14, date-time 15–18, enum 12–16,
// string/UUID/unknown 14–18). `numeric` sits at the TOP of its band (13, not
// the band's midpoint) — real-browser measurement against the app's actual
// UI font showed a negative Int32 extreme ("-2147483648") already needs every
// bit of that room; going narrower would make the single most common numeric
// `{name:Type}` declaration overflow on its own valid range, not just an
// edge case. Even at 13ch, a full-range `UInt64`/`Int128`/`Int256`/
// `Decimal128`/`Decimal256` literal (up to 20–40 digits) still needs to
// scroll — no width inside the issue's compact-band contract can fit those
// without abandoning "materially narrower than 150px" for the whole numeric
// family, so that's the accepted tradeoff the issue's own "preserve
// horizontal scrolling for values longer than the visible width" requirement
// exists for, not a gap in this table.
const WIDTH_CH: Record<FilterWidthCategory, number> = {
  bool: 9,
  numeric: 13,
  date: 13,
  datetime: 17,
  enum: 14,
  string: 16,
};

/**
 * Which width category a declared `{name:Type}` field falls into.
 * `isEnumLike` is the caller's own decision (an `Enum8`/`Enum16` declaration
 * OR a Dashboard curated Filter-source single-select — see
 * `fieldControlKind`/`buildFilterBar`'s curated branch) — it always wins over
 * the type's own base, since an enum/curated dropdown's width is about the
 * option labels, not the underlying scalar. Otherwise falls back to the
 * generic `'string'` band for anything not recognized as boolean/numeric/
 * date/date-time (String, UUID, FixedString, Array, an unparsable
 * declaration, …) — the same "opaque passthrough" fallback
 * `parseParamType` itself uses. Pure.
 */
export function filterWidthCategory(type: string, isEnumLike: boolean = false): FilterWidthCategory {
  if (isEnumLike) return 'enum';
  const base = parseParamType(type).base;
  if (BOOL_TINY_INT.test(base)) return 'bool';
  if (NUMERIC_BASE.test(base)) return 'numeric';
  if (base === 'Date' || base === 'Date32') return 'date';
  if (base === 'DateTime' || base === 'DateTime64') return 'datetime';
  return 'string';
}

/**
 * The stable `ch`-unit width a `{name:Type}` field's `.var-input` should use
 * for its whole lifetime — `filterWidthCategory`'s resolved band, in `ch`.
 * Pure; see `filterWidthCategory` for the category rules.
 */
export function filterInputWidthCh(type: string, isEnumLike: boolean = false): number {
  return WIDTH_CH[filterWidthCategory(type, isEnumLike)];
}
