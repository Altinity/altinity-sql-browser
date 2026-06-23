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
 * @param marks [{start, end, cls}] — half-open ranges. Overlaps resolve by
 *   priority: 'active' > 'match' > the first cls present (e.g. 'bracket').
 * @returns [{text, cls|null}] covering the whole string in order.
 */
export function buildMarkSegments(value, marks) {
  if (!marks.length) return [{ text: value, cls: null }];
  const points = new Set([0, value.length]);
  for (const m of marks) { points.add(m.start); points.add(m.end); }
  const sorted = [...points].filter((p) => p >= 0 && p <= value.length).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const text = value.slice(a, b);
    const cover = marks.filter((m) => m.start <= a && m.end >= b);
    if (cover.length) {
      const cls = cover.some((m) => m.cls === 'active') ? 'active'
        : cover.some((m) => m.cls === 'match') ? 'match'
          : cover[0].cls;
      out.push({ text, cls });
    } else {
      out.push({ text, cls: null });
    }
  }
  return out;
}
