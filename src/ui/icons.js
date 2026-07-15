// Inline SVG icons. `svg`/`svgFilled` build single-path icons; `iconEl` builds
// multi-element icons from an innerHTML body. `Icon` is the named set the UI
// uses. All return detached SVG elements (built via the `s()` SVG hyperscript).

import { s } from './dom.js';

// Shared stroke attributes for the outlined icons.
const stroked = (stroke) => ({
  stroke: 'currentColor', 'stroke-width': stroke,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
});

/** Single-path stroked icon. */
export function svg(d, w = 12, hgt = 12, opts = {}) {
  const { stroke = 1.4, fill = 'none' } = opts;
  return s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, fill: fill || null, ...stroked(stroke) },
    s('path', { d }));
}

// in src/ui/icons.js — for full-color, multi-element art (gradients, blends)
// that shouldn't be forced into the single-fill/stroke icon system above.
export function svgArt(body, w, h, vbW = w, vbH = h) {
  return s('svg', { width: w, height: h, viewBox: `0 0 ${vbW} ${vbH}`, html: body });
}

/** Single-path filled icon. `vbW`/`vbH` default to the display size, but can
 *  differ when the path is authored in a different coordinate space. */
export function svgFilled(d, w = 12, hgt = 12, vbW = w, vbH = hgt) {
  return s('svg', { width: w, height: hgt, viewBox: `0 0 ${vbW} ${vbH}`, fill: 'currentColor' },
    s('path', { d }));
}

/** Multi-element stroked icon from an innerHTML body. */
export function iconEl(body, w = 14, hgt = 14, stroke = 1.4) {
  return s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, fill: 'none', ...stroked(stroke), html: body });
}

export const Icon = {
  brand: () => svgArt(`<defs><linearGradient xlink:href="#a" id="b" x1="49.43" x2="21.19" y1="564.05" y2="486.25" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"/><linearGradient id="a" x1="49.43" x2="21.19" y1="564.05" y2="486.25" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#009cd0"/><stop offset=".16" stop-color="#02a0d4"/><stop offset=".33" stop-color="#08acdf"/><stop offset=".49" stop-color="#12c0f1"/><stop offset=".66" stop-color="#10bced"/><stop offset=".83" stop-color="#0ab0e2"/><stop offset="1" stop-color="#009cd0"/></linearGradient><linearGradient xlink:href="#a" id="c" x1="0" x2="48.75" y1="472.36" y2="472.36"/><linearGradient id="d" x1=".05" x2="24.5" y1="493.62" y2="493.62" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".03" stop-color="#f2f7fb"/><stop offset=".19" stop-color="#b3d2e7"/><stop offset=".34" stop-color="#7cb2d5"/><stop offset=".5" stop-color="#5097c7"/><stop offset=".64" stop-color="#2d83bc"/><stop offset=".78" stop-color="#1474b4"/><stop offset=".9" stop-color="#056bb0"/><stop offset="1" stop-color="#0068ae"/></linearGradient><linearGradient id="e" x1="73.23" x2="97.68" y1="507.9" y2="507.9" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0068ae"/><stop offset=".12" stop-color="#046aaf"/><stop offset=".25" stop-color="#1072b3"/><stop offset=".38" stop-color="#257eba"/><stop offset=".5" stop-color="#418fc3"/><stop offset=".63" stop-color="#66a4ce"/><stop offset=".76" stop-color="#93bfdd"/><stop offset=".88" stop-color="#c7deed"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="f" x1="50.7" x2="74.92" y1="522" y2="522" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0068ae"/><stop offset=".09" stop-color="#096eb1"/><stop offset=".23" stop-color="#237db9"/><stop offset=".41" stop-color="#4d95c6"/><stop offset=".62" stop-color="#86b8d9"/><stop offset=".86" stop-color="#cfe3f0"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><g style="isolation:isolate"><path d="M97.68 56.29 73.23 42.21v56.37l24.45 14.12z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="m73.23 42.21 24.45 14.11V28.09Z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="m73.25 42.2 24.43-14.11L73.25 14 48.79 28.08l24.44 14.11z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="M73.34 14.12 48.89 0 24.45 14.18.1 28.23l-.1.06.09.05v28.12L24.45 42.4h.1L49.4 27.94Z" style="fill:url(#b)" transform="scale(.0999 .10208)"/><path d="m48.75 84.87-24.3-14.35v-28L.21 56.53l-.12-.07v.14l-.09.06.09.05v27.94L0 84.7l.09.06V113L24.3 99z" style="fill:url(#c)" transform="scale(.0999 .10208)"/><path d="M.05 56.44 24.5 70.55V42.32Z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="M.05 56.49 24.5 70.6V42.37Z" style="mix-blend-mode:multiply;fill:url(#d)" transform="scale(.0999 .10208)"/><path d="m73.23 42.21 24.45 14.11V28.09Z" style="mix-blend-mode:multiply;fill:url(#e)" transform="scale(.0999 .10208)"/><path d="M97.68 28.09 73.23 14 48.79 28.13l24.46 14.12z" style="mix-blend-mode:multiply;fill:url(#f)" transform="scale(.0999 .10208)"/></g>`,
      22, 26, 9.758, 11.536),
  chev: () => svg('M3 2l3 3-3 3', 10, 10, { stroke: 1.6 }),
  chevDown: () => svg('M2 3l3 3 3-3', 10, 10, { stroke: 1.6 }),
  database: () => iconEl('<ellipse cx="7" cy="3" rx="5" ry="1.6"/><path d="M2 3v8c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6V3M2 7c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6"/>'),
  table: () => iconEl('<rect x="2" y="2.5" width="10" height="9" rx="1"/><path d="M2 5.5h10M2 8.5h10M5.5 5.5v6"/>'),
  col: () => iconEl('<rect x="2" y="2" width="8" height="8" rx="1"/><path d="M2 5h8M2 8h8"/>', 12, 12),
  play: () => svgFilled('M3 2l7 4-7 4z'),
  plus: () => svg('M6 2v8M2 6h8', 12, 12, { stroke: 1.6 }),
  close: () => svg('M2 2l6 6M8 2l-6 6', 10, 10, { stroke: 1.6 }),
  spinner: () => svg('M6 1.2a4.8 4.8 0 1 1-4.8 4.8', 12, 12, { stroke: 1.6 }),
  search: () => iconEl('<circle cx="5" cy="5" r="3"/><path d="M7.5 7.5L10 10"/>', 12, 12, 1.5),
  sun: () => iconEl('<circle cx="7" cy="7" r="2.4"/><path d="M7 1.5v1.4M7 11.1v1.4M1.5 7h1.4M11.1 7h1.4M3 3l1 1M10 10l1 1M11 3l-1 1M4 10l-1 1"/>'),
  moon: () => svg('M11 7.5A4 4 0 1 1 6.5 3a3.2 3.2 0 0 0 4.5 4.5z', 14, 14),
  clock: () => iconEl('<circle cx="5.5" cy="5.5" r="4"/><path d="M5.5 3.5V5.5L7 6.5"/>', 11, 11),
  rows: () => iconEl('<rect x="1.5" y="2" width="8" height="7" rx=".5"/><path d="M1.5 4.5h8M1.5 7h8"/>', 11, 11),
  bytes: () => svg('M2 8.5V3.5L5.5 6 9 3.5v5', 11, 11),
  sortAsc: () => svg('M5 8V2M2.5 4.5L5 2l2.5 2.5', 10, 10, { stroke: 1.5 }),
  sortDesc: () => svg('M5 2v6M2.5 5.5L5 8l2.5-2.5', 10, 10, { stroke: 1.5 }),
  star: (filled = false) => {
    const e = iconEl('<path d="M6 1.5l1.4 2.9 3.1.4-2.3 2.2.6 3.1L6 8.6l-2.8 1.5.6-3.1-2.3-2.2 3.1-.4z"/>', 12, 12, 1.2);
    e.setAttribute('fill', filled ? 'currentColor' : 'none');
    return e;
  },
  // Library tab glyph — stacked layers, so it doesn't clash with the per-query ★.
  layers: () => iconEl('<path d="M6 1.4 1.2 3.7 6 6l4.8-2.3z"/><path d="M1.6 6 6 8.1 10.4 6"/><path d="M1.6 8.4 6 10.5l4.4-2.1"/>', 12, 12, 1.2),
  history: () => svg('M2.5 5.5a3.5 3.5 0 1 1 1 2.5M2 3v2.5h2.5M6 3.5V6l1.5 1', 12, 12),
  share: () => iconEl('<circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="6" r="1.5"/><circle cx="9" cy="9" r="1.5"/><path d="M4.3 5.3l3.4-1.6M4.3 6.7l3.4 1.6"/>', 12, 12),
  chart: () => svg('M2 10V7M5 10V4M8 10V6M11 10V2', 12, 12),
  // Funnel — the Filter result view (filter-role query preview).
  filter: () => svg('M2 3h8l-3 3.5v3l-2-1v-2z', 12, 12, { stroke: 1.4 }),
  json: () => svg('M4 1.5C2.5 1.5 2.5 3 2.5 4S2.5 5 1.5 6c1 1 1 2 1 2s0 1.5 1.5 1.5M8 1.5c1.5 0 1.5 1.5 1.5 2.5s0 1 1 2c-1 1-1 2-1 2s0 1.5-1.5 1.5', 12, 12),
  table2: () => iconEl('<rect x="1.5" y="2" width="9" height="8" rx=".5"/><path d="M1.5 4.5h9M1.5 7h9M4.5 4.5v5"/>', 12, 12),
  shortcuts: () => iconEl('<rect x="1.5" y="3" width="9" height="6" rx="1"/><path d="M3.5 5h.01M6 5h.01M8.5 5h.01M3.5 7h5"/>', 12, 12, 1.3),
  code: () => svg('M5 3L2 7l3 4M9 3l3 4-3 4', 14, 14, { stroke: 1.6 }),
  copy: () => iconEl('<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><path d="M2 8.5V2.5a1 1 0 0 1 1-1h6"/>', 12, 12),
  download: () => iconEl('<path d="M6 1.5v6.5M3.5 5.5L6 8l2.5-2.5"/><path d="M2 10h8"/>', 12, 12),
  upload: () => iconEl('<path d="M6 8.5V2M3.5 4.5L6 2l2.5 2.5"/><path d="M2 10h8"/>', 12, 12),
  logout: () => iconEl('<path d="M5.5 2.5H3a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h2.5"/><path d="M7 8.5L9.5 6 7 3.5M9.5 6H4.5"/>', 12, 12),
  // Login-screen glyphs (SSO shield, password eye, host server, connect arrow).
  shield: () => iconEl('<path d="M7 1.2l4.5 1.6v3.1c0 2.7-1.9 5-4.5 5.8-2.6-.8-4.5-3.1-4.5-5.8V2.8z"/><path d="M5 6.8l1.4 1.4 2.6-2.7"/>', 14, 14, 1.4),
  eye: () => iconEl('<path d="M1.3 7S3.3 3 7 3s5.7 4 5.7 4-2 4-5.7 4S1.3 7 1.3 7z"/><circle cx="7" cy="7" r="1.7"/>', 14, 14, 1.4),
  eyeOff: () => iconEl('<path d="M5.4 3.3A5.6 5.6 0 0 1 7 3c3.7 0 5.7 4 5.7 4a9.6 9.6 0 0 1-1.7 2.1M8.6 8.6A1.7 1.7 0 0 1 5.4 5.4M1.3 7S3.3 3 7 3m-5.7 4a9.6 9.6 0 0 0 1.7 2.1"/><path d="M1.8 1.8l10.4 10.4"/>', 14, 14, 1.4),
  server: () => iconEl('<rect x="1.8" y="2" width="8.4" height="3.4" rx="1"/><rect x="1.8" y="6.6" width="8.4" height="3.4" rx="1"/><path d="M3.8 3.7h.01M3.8 8.3h.01"/>', 12, 12, 1.3),
  arrow: () => svg('M2 6h7.5M7 3.5L9.5 6 7 8.5', 12, 12, { stroke: 1.6 }),
  refresh: () => svg('M10.5 6a4.5 4.5 0 1 1-1.3-3.2M10.5 1.5V4H8', 12, 12, { stroke: 1.5 }),
  // Same glyph as the JSON view tab so the Format button's { } matches it.
  braces: () => svg('M4 1.5C2.5 1.5 2.5 3 2.5 4S2.5 5 1.5 6c1 1 1 2 1 2s0 1.5 1.5 1.5M8 1.5c1.5 0 1.5 1.5 1.5 2.5s0 1 1 2c-1 1-1 2-1 2s0 1.5-1.5 1.5', 12, 12),
  // EXPLAIN button + Explain view: an indented plan-tree of lines.
  plan: () => iconEl('<path d="M2 2.6h8M4 5.5h6M4 8.4h4.5M2 5.5h.01M2 8.4h.01"/>', 12, 12, 1.4),
  // Indexes view: a key.
  key: () => iconEl('<circle cx="4" cy="4" r="2.4"/><path d="M5.7 5.7l4.3 4.3M8.3 8.3l1-1M9.3 9.3l1-1"/>', 12, 12, 1.3),
  // Expand to fullscreen: four corner brackets, centred + symmetric in the 12-box
  // (2.5 margins, 2.5-long legs). The old path was off-centre (bbox 10×8, touching
  // the right edge) on half-pixel coords, so at ~12px each engine's stroke
  // rasteriser snapped it differently — Chrome/Firefox blurred the corners into
  // solid `[ ]` brackets while Safari kept them crisp. Centred + symmetric renders
  // consistently across engines.
  expand: () => iconEl('<path d="M2.5 5V2.5H5M7 2.5H9.5V5M9.5 7V9.5H7M5 9.5H2.5V7"/>', 12, 12, 1.4),
  // Zoom-out bar (pairs with plus for zoom-in).
  minus: () => svg('M2 6h8', 12, 12, { stroke: 1.6 }),
  // Curved-arrow undo / redo (mirror images) for the schema node-move history.
  undo: () => svg('M4.5 3.5 2 6l2.5 2.5M2 6h5a2.5 2.5 0 0 1 2.5 2.5', 12, 12),
  redo: () => svg('M7.5 3.5 10 6l-2.5 2.5M10 6H5a2.5 2.5 0 0 0-2.5 2.5', 12, 12),
  bookmark: () => iconEl('<path d="M3.5 1.8h5a.6.6 0 0 1 .6.6v8.2l-3.1-2-3.1 2V2.4a.6.6 0 0 1 .6-.6z"/>', 12, 12, 1.3),
  pencil: () => iconEl('<path d="M2 10l.6-2.5 5-5 1.9 1.9-5 5z"/><path d="M7 3.1l1.9 1.9"/>', 12, 12),
  trash: () => iconEl('<path d="M2.5 3.5h7"/><path d="M4 3.5V2.4h3v1.1"/><path d="M3.4 3.5l.45 6.6a.6.6 0 0 0 .6.5h2.9a.6.6 0 0 0 .6-.5l.45-6.6"/>', 12, 12, 1.2),
  github: () => svgFilled('M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12', 15, 15, 24, 24),
};
