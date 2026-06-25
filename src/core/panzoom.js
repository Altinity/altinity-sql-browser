// Pure SVG viewBox algebra for the fullscreen pipeline-graph pan/zoom. A viewBox
// is `{ x, y, w, h }` in svg user units; the DOM wiring (wheel/drag listeners,
// pixel→svg conversion) lives in src/ui/explain-graph.js. No DOM, no globals.

/**
 * Initial viewBox framing a `gw × gh` graph with `pad` (fraction of each side).
 * SVG `preserveAspectRatio` handles fitting the box into any viewport shape.
 */
export function fitBox(gw, gh, pad = 0.04) {
  const px = gw * pad;
  const py = gh * pad;
  return { x: -px, y: -py, w: gw + 2 * px, h: gh + 2 * py };
}

/**
 * Zoom by `factor` (>1 = zoom in) keeping the svg-space point `(cx, cy)` fixed.
 * Width is clamped to `[minW, maxW]`; height scales by the same ratio so the
 * aspect is preserved.
 */
export function zoomBox(vb, factor, cx, cy, minW, maxW) {
  if (!vb.w || !vb.h) return vb; // nothing to zoom (degenerate box)
  const want = vb.w / factor;
  const w = Math.max(minW, Math.min(maxW, want));
  const k = w / vb.w; // actual applied scale after clamping
  const h = vb.h * k;
  const rx = (cx - vb.x) / vb.w;
  const ry = (cy - vb.y) / vb.h;
  return { x: cx - rx * w, y: cy - ry * h, w, h };
}

/** Translate the viewBox by svg-unit deltas. */
export function panBox(vb, dx, dy) {
  return { x: vb.x - dx, y: vb.y - dy, w: vb.w, h: vb.h };
}

/** Serialize a viewBox for the SVG `viewBox` attribute. */
export function viewBoxStr(vb) {
  return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}
