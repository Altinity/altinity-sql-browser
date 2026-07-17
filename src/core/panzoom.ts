// Pure SVG viewBox algebra for the fullscreen pipeline-graph pan/zoom. A viewBox
// is `{ x, y, w, h }` in svg user units; the DOM wiring (wheel/drag listeners,
// pixel→svg conversion) lives in src/ui/explain-graph.js. No DOM, no globals.

/** An SVG viewBox in svg user units — top-left `x`/`y`, size `w`/`h`. */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Initial viewBox framing a `gw × gh` graph with `pad` (fraction of each side).
 * SVG `preserveAspectRatio` handles fitting the box into any viewport shape.
 */
export function fitBox(gw: number, gh: number, pad = 0.04): ViewBox {
  const px = gw * pad;
  const py = gh * pad;
  return { x: -px, y: -py, w: gw + 2 * px, h: gh + 2 * py };
}

/**
 * Initial viewBox that fills the container's WIDTH with the `gw × gh` graph and
 * lets the height overflow (the user pans/scrolls down). The box width is the
 * padded graph width; its height is set to the container's aspect ratio so
 * `preserveAspectRatio … meet` maps width 1:1 with no horizontal letterboxing.
 * Anchored at the top. Falls back to the graph height when the container size is
 * unknown (e.g. not yet laid out).
 */
export function fitWidthBox(gw: number, gh: number, cw: number, ch: number, pad = 0.04): ViewBox {
  const px = gw * pad;
  const w = gw + 2 * px;
  const h = cw > 0 && ch > 0 ? w * (ch / cw) : gh + 2 * px;
  return { x: -px, y: -px, w, h };
}

/**
 * Zoom by `factor` (>1 = zoom in) keeping the svg-space point `(cx, cy)` fixed.
 * Width is clamped to `[minW, maxW]`; height scales by the same ratio so the
 * aspect is preserved.
 */
export function zoomBox(vb: ViewBox, factor: number, cx: number, cy: number, minW: number, maxW: number): ViewBox {
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
export function panBox(vb: ViewBox, dx: number, dy: number): ViewBox {
  return { x: vb.x - dx, y: vb.y - dy, w: vb.w, h: vb.h };
}

/** Serialize a viewBox for the SVG `viewBox` attribute. */
export function viewBoxStr(vb: ViewBox): string {
  return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}
