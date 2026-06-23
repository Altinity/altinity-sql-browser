// Pure caret geometry for positioning the autocomplete popover (#26). No DOM.
//
// The editor is `white-space: pre` in a fixed-size monospace font, so a caret's
// pixel offset is plain line/column arithmetic — char width is passed in by the
// caller (a constant tuned to the font; see CHAR_WIDTH_PX in editor.js) rather
// than measured, keeping this fully testable. If a proportional font or soft
// wrapping is ever introduced, switch to a mirror-div measurement.

/** Zero-based {line, col} of caret position `pos` within `value`. */
export function caretLineCol(value, pos) {
  const before = value.slice(0, pos);
  return { line: before.split('\n').length - 1, col: pos - (before.lastIndexOf('\n') + 1) };
}

/**
 * Pixel offset of the caret within the editor's text area, accounting for
 * padding and the current scroll.
 * @param m { charWidth, lhPx, padX, padY, scrollTop, scrollLeft }
 */
export function caretXY(value, pos, m) {
  const { line, col } = caretLineCol(value, pos);
  return {
    x: m.padX + col * m.charWidth - (m.scrollLeft || 0),
    y: m.padY + line * m.lhPx - (m.scrollTop || 0),
  };
}

/**
 * Inverse of caretXY for hover (#27): the text offset at a point, where relX/relY
 * are already in CSS px relative to the text origin (after padding + scroll).
 * Returns null when the point is outside the text's lines, OR past the end of a
 * short line's glyphs — otherwise a dwell in the blank space right of e.g.
 * `SELECT count` would map to the end of `count` and pop a phantom hover card
 * nowhere near a token (#27). A half-column tolerance keeps the last glyph live.
 */
export function offsetFromXY(value, relX, relY, m) {
  const lines = value.split('\n');
  const line = Math.floor(relY / m.lhPx);
  if (line < 0 || line >= lines.length) return null;
  const rawCol = relX / m.charWidth;
  if (rawCol > lines[line].length + 0.5) return null; // beyond the line's glyphs
  const col = Math.max(0, Math.min(Math.round(rawCol), lines[line].length));
  let pos = 0;
  for (let k = 0; k < line; k++) pos += lines[k].length + 1;
  return pos + col;
}
