// Pure segmentation for the editor's transparent mark overlay (#23 search
// highlights, #24 bracket pair). No DOM.
//
// The overlay is a second `color: transparent` <pre> layered below the token
// <pre>; only the marked spans carry a background, so the token render path is
// never touched. This splits `value` into ordered {text, cls} segments — the
// DOM painter renders cls != null with a `mark-<cls>` background span and the
// rest as plain (transparent) text, keeping the overlay's layout identical to
// the editor's for pixel-aligned highlights.

/**
 * @param value the full editor text
 * @param marks [{start, end, cls}] — half-open ranges, **sorted by start and
 *   non-overlapping**. They always are here: search matches come back in order
 *   and disjoint, and the bracket pair (the only other source, never mixed with
 *   search marks) is two sorted width-1 ranges. The single linear pass keeps the
 *   keystroke path off a quadratic per-segment scan.
 * @returns [{text, cls|null}] covering the whole string in order.
 */
export function buildMarkSegments(value, marks) {
  const out = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) out.push({ text: value.slice(pos, m.start), cls: null });
    out.push({ text: value.slice(m.start, m.end), cls: m.cls });
    pos = m.end;
  }
  if (pos < value.length || !out.length) out.push({ text: value.slice(pos), cls: null });
  return out;
}
