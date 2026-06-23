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
