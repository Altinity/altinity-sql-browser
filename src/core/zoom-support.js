// Pure helper for the page's CSS `zoom` layout dependency. The whole UI rides on
// `html { zoom: var(--zoom) }` (see styles.css). Most of the layout and all the
// pointer/caret/drag math are fine across engines — `getBoundingClientRect` and
// pointer coords share a coordinate space within an engine, so the corrections
// self-calibrate (they divide by the live rect/offset ratio, which is the zoom
// factor on Chromium and 1 on WebKit/Safari, and both are correct).
//
// The one place engines genuinely diverge is **viewport units under `zoom`**:
// Chromium's `vw`/`vh` ignore `zoom`, so a `100vh` element is `--zoom`× too tall;
// WebKit/Safari's track `zoom`, so `100vh` is exactly one screen. The fullscreen
// graph panels size off `vw`/`vh`, so they need a per-engine divisor — measured
// live (see app.applyViewportZoom) and published as `--vp-zoom` (#70).

// The divisor the fullscreen panels must apply to viewport units so they fill
// exactly one real screen: the overshoot of a `height:100vh` probe (`vhPx`) over
// a known one-screen reference (`refPx`, the `height:100%`-sized #root). Chromium
// → ~`--zoom`; WebKit/Safari → ~1. Returns `null` when either measurement is
// missing or degenerate (e.g. happy-dom has no layout) so the caller leaves the
// CSS default (`--vp-zoom: var(--zoom)`) in place rather than mis-set it.
export function viewportZoom(vhPx, refPx) {
  if (!Number.isFinite(vhPx) || vhPx <= 0) return null;
  if (!Number.isFinite(refPx) || refPx <= 0) return null;
  return vhPx / refPx;
}
