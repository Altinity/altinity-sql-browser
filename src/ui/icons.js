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
  json: () => svg('M4 1.5C2.5 1.5 2.5 3 2.5 4S2.5 5 1.5 6c1 1 1 2 1 2s0 1.5 1.5 1.5M8 1.5c1.5 0 1.5 1.5 1.5 2.5s0 1 1 2c-1 1-1 2-1 2s0 1.5-1.5 1.5', 12, 12),
  table2: () => iconEl('<rect x="1.5" y="2" width="9" height="8" rx=".5"/><path d="M1.5 4.5h9M1.5 7h9M4.5 4.5v5"/>', 12, 12),
  shortcuts: () => iconEl('<rect x="1.5" y="3" width="9" height="6" rx="1"/><path d="M3.5 5h.01M6 5h.01M8.5 5h.01M3.5 7h5"/>', 12, 12, 1.3),
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
  // Same glyph as the JSON view tab so the Format button's { } matches it.
  braces: () => svg('M4 1.5C2.5 1.5 2.5 3 2.5 4S2.5 5 1.5 6c1 1 1 2 1 2s0 1.5 1.5 1.5M8 1.5c1.5 0 1.5 1.5 1.5 2.5s0 1 1 2c-1 1-1 2-1 2s0 1.5-1.5 1.5', 12, 12),
  bookmark: () => iconEl('<path d="M3.5 1.8h5a.6.6 0 0 1 .6.6v8.2l-3.1-2-3.1 2V2.4a.6.6 0 0 1 .6-.6z"/>', 12, 12, 1.3),
  pencil: () => iconEl('<path d="M2 10l.6-2.5 5-5 1.9 1.9-5 5z"/><path d="M7 3.1l1.9 1.9"/>', 12, 12),
  trash: () => iconEl('<path d="M2.5 3.5h7"/><path d="M4 3.5V2.4h3v1.1"/><path d="M3.4 3.5l.45 6.6a.6.6 0 0 0 .6.5h2.9a.6.6 0 0 0 .6-.5l.45-6.6"/>', 12, 12, 1.2),
  github: () => svgFilled('M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12', 15, 15, 24, 24),
};
