// The Altinity® logomark — a SUPPLIED BRAND ASSET, not authored UI.
//
// Its 26 gradient stops are fixed by the brand and are deliberately outside the
// DESIGN.md palette: the mark must not be recoloured to fit the product's tokens,
// and its blues must never be borrowed for UI chrome (that is what --accent is
// for). It lives in its own module for exactly that reason — `.impeccable/config.json`
// excludes this one file from the design-system colour detector, which keeps the
// exclusion precise instead of silencing all ~60 real icons in ./icons.ts.
//
// Do not hand-edit the path data. Replace the whole file if the brand mark changes.

import { svgArt } from './icons.js';

/** Display size and the artwork's own coordinate space. */
const W = 22;
const H = 26;
const VB_W = 9.758;
const VB_H = 11.536;

const ART = `<defs><linearGradient xlink:href="#a" id="b" x1="49.43" x2="21.19" y1="564.05" y2="486.25" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"/><linearGradient id="a" x1="49.43" x2="21.19" y1="564.05" y2="486.25" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#009cd0"/><stop offset=".16" stop-color="#02a0d4"/><stop offset=".33" stop-color="#08acdf"/><stop offset=".49" stop-color="#12c0f1"/><stop offset=".66" stop-color="#10bced"/><stop offset=".83" stop-color="#0ab0e2"/><stop offset="1" stop-color="#009cd0"/></linearGradient><linearGradient xlink:href="#a" id="c" x1="0" x2="48.75" y1="472.36" y2="472.36"/><linearGradient id="d" x1=".05" x2="24.5" y1="493.62" y2="493.62" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset=".03" stop-color="#f2f7fb"/><stop offset=".19" stop-color="#b3d2e7"/><stop offset=".34" stop-color="#7cb2d5"/><stop offset=".5" stop-color="#5097c7"/><stop offset=".64" stop-color="#2d83bc"/><stop offset=".78" stop-color="#1474b4"/><stop offset=".9" stop-color="#056bb0"/><stop offset="1" stop-color="#0068ae"/></linearGradient><linearGradient id="e" x1="73.23" x2="97.68" y1="507.9" y2="507.9" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0068ae"/><stop offset=".12" stop-color="#046aaf"/><stop offset=".25" stop-color="#1072b3"/><stop offset=".38" stop-color="#257eba"/><stop offset=".5" stop-color="#418fc3"/><stop offset=".63" stop-color="#66a4ce"/><stop offset=".76" stop-color="#93bfdd"/><stop offset=".88" stop-color="#c7deed"/><stop offset="1" stop-color="#fff"/></linearGradient><linearGradient id="f" x1="50.7" x2="74.92" y1="522" y2="522" gradientTransform="matrix(1 0 0 -1 0 550.11)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0068ae"/><stop offset=".09" stop-color="#096eb1"/><stop offset=".23" stop-color="#237db9"/><stop offset=".41" stop-color="#4d95c6"/><stop offset=".62" stop-color="#86b8d9"/><stop offset=".86" stop-color="#cfe3f0"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><g style="isolation:isolate"><path d="M97.68 56.29 73.23 42.21v56.37l24.45 14.12z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="m73.23 42.21 24.45 14.11V28.09Z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="m73.25 42.2 24.43-14.11L73.25 14 48.79 28.08l24.44 14.11z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="M73.34 14.12 48.89 0 24.45 14.18.1 28.23l-.1.06.09.05v28.12L24.45 42.4h.1L49.4 27.94Z" style="fill:url(#b)" transform="scale(.0999 .10208)"/><path d="m48.75 84.87-24.3-14.35v-28L.21 56.53l-.12-.07v.14l-.09.06.09.05v27.94L0 84.7l.09.06V113L24.3 99z" style="fill:url(#c)" transform="scale(.0999 .10208)"/><path d="M.05 56.44 24.5 70.55V42.32Z" style="fill:#009cd0" transform="scale(.0999 .10208)"/><path d="M.05 56.49 24.5 70.6V42.37Z" style="mix-blend-mode:multiply;fill:url(#d)" transform="scale(.0999 .10208)"/><path d="m73.23 42.21 24.45 14.11V28.09Z" style="mix-blend-mode:multiply;fill:url(#e)" transform="scale(.0999 .10208)"/><path d="M97.68 28.09 73.23 14 48.79 28.13l24.46 14.12z" style="mix-blend-mode:multiply;fill:url(#f)" transform="scale(.0999 .10208)"/></g>`;

/** The full-colour Altinity logomark, as a detached <svg>. */
export function brandMark(): SVGElement {
  return svgArt(ART, W, H, VB_W, VB_H);
}
