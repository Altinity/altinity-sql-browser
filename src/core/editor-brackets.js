// Pure bracket logic for the editor (#24): caret-adjacent pair matching and the
// auto-close / wrap / type-over / pair-delete decision. No DOM.

// Auto-close pairs. `{`/`}` is deliberately excluded (niche ClickHouse JSON
// context) per the resolved Phase-1b decision; bracket *matching* still spans
// it (MATCH_* below) since highlighting a `{}` pair is harmless and useful.
const OPEN = { '(': ')', '[': ']' };
const QUOTES = new Set(["'", '"', '`']);
const CLOSERS = new Set([')', ']', '}']);
const MATCH_OPEN = { '(': ')', '[': ']', '{': '}' };
const MATCH_CLOSE = { ')': '(', ']': '[', '}': '{' };

// Walk from `idx` in `dir` (+1 from an opener, -1 from a closer) tracking nesting
// depth; return [openIdx, closeIdx] for the matched pair, or null if unbalanced
// or `idx` is not the expected bracket.
function scan(value, idx, dir) {
  const ch = value[idx];
  if (dir === 1 && MATCH_OPEN[ch]) {
    let depth = 0;
    for (let k = idx; k < value.length; k++) {
      if (value[k] === ch) depth++;
      else if (value[k] === MATCH_OPEN[ch]) { depth--; if (depth === 0) return [idx, k]; }
    }
  } else if (dir === -1 && MATCH_CLOSE[ch]) {
    let depth = 0;
    for (let k = idx; k >= 0; k--) {
      if (value[k] === ch) depth++;
      else if (value[k] === MATCH_CLOSE[ch]) { depth--; if (depth === 0) return [k, idx]; }
    }
  }
  return null;
}

/**
 * The bracket pair adjacent to `caret`: an opener at value[caret] (scan forward)
 * or a closer at value[caret-1] (scan backward). Returns [openIdx, closeIdx] or
 * null.
 */
export function matchBracketAt(value, caret) {
  return scan(value, caret, 1) || (caret > 0 ? scan(value, caret - 1, -1) : null);
}

/**
 * Decide the edit for a key pressed at selection [s, e]. Returns
 * { value, selStart, selEnd } to apply, or null when the key isn't a bracket
 * action (the caller falls through to its normal handling).
 *   • opener: wrap a selection, else insert the pair with the caret inside
 *   • quote: wrap a selection, type over an existing quote, else auto-close
 *   • closer: type over an existing matching closer
 *   • Backspace inside an empty ()/[]/'' pair: delete both halves
 */
export function bracketEdit(value, s, e, key) {
  if (OPEN[key]) {
    const close = OPEN[key];
    if (s !== e) {
      return { value: value.slice(0, s) + key + value.slice(s, e) + close + value.slice(e), selStart: s + 1, selEnd: e + 1 };
    }
    return { value: value.slice(0, s) + key + close + value.slice(e), selStart: s + 1, selEnd: s + 1 };
  }
  if (QUOTES.has(key)) {
    if (s !== e) {
      return { value: value.slice(0, s) + key + value.slice(s, e) + key + value.slice(e), selStart: s + 1, selEnd: e + 1 };
    }
    if (value[s] === key) {
      return { value, selStart: s + 1, selEnd: s + 1 }; // type over the auto-inserted quote
    }
    return { value: value.slice(0, s) + key + key + value.slice(e), selStart: s + 1, selEnd: s + 1 };
  }
  if (CLOSERS.has(key) && s === e && value[s] === key) {
    return { value, selStart: s + 1, selEnd: s + 1 }; // type over the auto-inserted closer
  }
  if (key === 'Backspace' && s === e && s > 0) {
    const prev = value[s - 1];
    const next = value[s];
    if ((OPEN[prev] && next === OPEN[prev]) || (QUOTES.has(prev) && next === prev)) {
      return { value: value.slice(0, s - 1) + value.slice(s + 1), selStart: s - 1, selEnd: s - 1 };
    }
  }
  return null;
}
