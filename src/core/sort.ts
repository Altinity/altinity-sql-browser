// Pure result-table sorting. Numeric when both cells parse as numbers,
// lexicographic otherwise. Returns a new array; never mutates the input.

/** The global results-table sort: a zero-based column index (grid-render.js
 * sorts positionally), or `col: null` for the natural row order. */
export interface ResultSort {
  col: number | null;
  dir: 'asc' | 'desc';
}

/** True when `v` is a string that is wholly a number literal. */
function looksNumeric(v: unknown): boolean {
  const s = String(v);
  return !Number.isNaN(parseFloat(s)) && /^[\-0-9.eE+]+$/.test(s);
}

/**
 * Sort `rows` by column index `col` in direction `dir` ('asc' | 'desc').
 * When `col` is null the input is returned unchanged (a copy is not made).
 */
export function sortRows(rows: unknown[][], col: number | null, dir: 'asc' | 'desc' = 'asc'): unknown[][] {
  if (col == null) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = a[col];
    const bv = b[col];
    const both = looksNumeric(av) && looksNumeric(bv);
    const cmp = both
      ? parseFloat(String(av)) - parseFloat(String(bv))
      : String(av).localeCompare(String(bv));
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}
