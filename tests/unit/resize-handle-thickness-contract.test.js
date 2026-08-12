// Issue #592 (inherited from #586/#593 phase 1, filed against this issue's own
// "Extra acceptance") — an independent JS↔CSS drift contract, the same
// precedent `typography-contract.test.js` already establishes for
// `FONT_BYTE_BUDGET`/the type ramp: a layout constant JS reserves space for
// and CSS separately declares must not drift unnoticed.
//
// `src/ui/app-shell.ts`'s dock-aware width ceiling reserves space for the
// resize handle(s) beside the docked inspector:
//   reservedPx: state.sidebarPx + HANDLE_PX * 2      // src/ui/app-shell.ts
//   const HANDLE_PX = 7;                              // src/ui/app-shell.ts
// The real handle width is declared independently in CSS:
//   .col-resize, .inspector-resize { width: 7px; }     // src/styles.css
// Nothing links the two at compile time or runtime — a CSS-only edit to the
// handle width would leave `reservedPx` wrong, silently narrowing the centre
// surface below `CENTRE_MIN_PX`, with no test failing (happy-dom evaluates no
// CSS layout, and the e2e assertions are inequalities, not exact geometry).
//
// This is a TEST-ONLY, enforcement-only addition per #592's non-goals: it
// reads both production files as plain text and asserts agreement; it never
// changes `HANDLE_PX`'s runtime ownership or the CSS declaration itself.
//
// Deliberately independent extraction: `extractHandlePxValues` and
// `extractSharedResizeWidthPx` never share a helper or a source read with each
// other — the whole point is to catch disagreement between two independently
// declared values, so "expected" and "actual" must never be derived through
// the same code path (a bug in a shared extractor would silently make both
// sides agree with each other while disagreeing with reality).
//
// Stays `.js` (not `.ts`) for the same reason as `typography-contract.test.js`
// and `schema-build.test.js`: it reads repo files through `node:fs`, and the
// project carries no `@types/node` (ADR-0002's deliberate deferral).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const APP_SHELL_PATH = 'src/ui/app-shell.ts';
const STYLES_PATH = 'src/styles.css';

const realAppShellSource = () => readFileSync(resolve(root, APP_SHELL_PATH), 'utf8');
const realStylesSource = () => readFileSync(resolve(root, STYLES_PATH), 'utf8');

/** Every `const HANDLE_PX = <number>;` declaration found in `jsSource`, in
 *  source order — comments stripped first (block AND line), so a comment
 *  merely mentioning the declaration can never be mistaken for a real one.
 *  Zero, one, or many: the caller decides what count is valid — this
 *  extractor itself never assumes there is exactly one. */
function extractHandlePxValues(jsSource) {
  const stripped = jsSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  return [...stripped.matchAll(/\bconst\s+HANDLE_PX\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g)].map((m) => Number(m[1]));
}

/** Every flat (non-nested) CSS rule in `cssSource` as `{ selectors, body }` —
 *  comments stripped first. Deliberately naive (no brace-nesting/at-rule
 *  awareness, unlike `scanFixedPositionDeclarations`'s general CSS lexer in
 *  `build/lib/check-legacy-owners.mjs`): this helper exists ONLY to find the
 *  one specific top-level `.col-resize, .inspector-resize { … }` rule this
 *  contract cares about, matching this repo's existing narrow, regex-based
 *  `typography-contract.test.js` precedent rather than reusing the general
 *  architecture-guard scanner for an unrelated, independent test. */
function flatCssRules(cssSource) {
  const stripped = cssSource.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
    body: m[2],
  }));
}

/** True when `selector` (one already-trimmed token from a comma-split
 *  selector LIST — never the whole list) TARGETS `className`'s OWN box — a
 *  bare `.col-resize`, a COMPOUND selector (`.inspector-resize.dragging`,
 *  class order either way, including a pseudo-CLASS like `:hover`, which
 *  still styles the same element's own box), or a DESCENDANT/combinator
 *  selector (`.shell .inspector-resize`, `.shell > .inspector-resize`).
 *  #592 review pass 3: the prior check was `selectors.includes('.col-
 *  resize')` — exact string-list membership — so a compound or descendant
 *  selector naming the SAME class was invisible to the extractor below even
 *  though it can still win the real cascade for that class. Matched with a
 *  negative lookahead for another identifier/hyphen character immediately
 *  after the class name, so `.col-resize` never false-matches a DIFFERENT,
 *  longer class that merely starts with the same text (`.col-resized`,
 *  `.col-resize-handle`). Deliberately EXCLUDES any selector containing a
 *  pseudo-ELEMENT (`::before`/`::after`, real occurrences in
 *  `src/styles.css` today, e.g. `.col-resize::before`,
 *  `.col-resize:hover::before, .col-resize.dragging::before`): a
 *  pseudo-element is an entirely separate generated box with its own
 *  independent `width` — styling it is not an override of the handle
 *  element's OWN width, so it is correctly out of this contract's scope
 *  (matching how the prior exact-match check already, if incidentally,
 *  never matched any of these either). */
function selectorTargetsResizeHandleClass(selector, className) {
  if (selector.includes('::')) return false;
  return new RegExp(`\\.${className}(?![\\w-])`).test(selector);
}

/** Every `width: <number>px` value declared by ANY flat rule whose selector
 *  list names `.col-resize` and/or `.inspector-resize` — together (the rule
 *  that governs both classes' shared width), alone (a more-specific, later-
 *  declared, or media-query-scoped override that could still win the real
 *  cascade for just one of the two classes even though it never mentions the
 *  other — the P1 gap `flatCssRules`'s own brace-agnostic regex already sees
 *  through one level of `@media { … }` nesting for: an inner flat rule is
 *  matched on its own, the outer at-rule prelude is simply skipped as
 *  unmatched text), OR as part of a COMPOUND/DESCENDANT selector naming
 *  either class (`selectorTargetsResizeHandleClass`, the pass-3 fix — a
 *  bare-class-list membership check alone missed `.inspector-
 *  resize.dragging { width: 8px; }` and `.shell .inspector-resize { width:
 *  8px; }` entirely, so either override silently escaped this contract).
 *  Order-independent; additional selectors in the same group, e.g.
 *  `.row-resize`, are allowed. Zero, one, or many, across however many
 *  matching rule groups exist: the caller decides what count is valid — and
 *  the contract below requires EXACTLY one, so ANY standalone, compound,
 *  descendant, or media-scoped override of either class's `width` makes the
 *  count 2+ and the contract fails closed (`css-ambiguous`) instead of
 *  silently reading only the grouped rule's own value while the browser's
 *  real cascade could render a completely different pixel width. */
function extractSharedResizeWidthPx(cssSource) {
  const values = [];
  for (const rule of flatCssRules(cssSource)) {
    const targets = rule.selectors.some(
      (s) => selectorTargetsResizeHandleClass(s, 'col-resize') || selectorTargetsResizeHandleClass(s, 'inspector-resize'),
    );
    if (!targets) continue;
    for (const m of rule.body.matchAll(/\bwidth\s*:\s*(-?\d+(?:\.\d+)?)px\s*;/g)) values.push(Number(m[1]));
  }
  return values;
}

/** The full contract, independently computed from both extractors: valid
 *  only when the JS side names EXACTLY one `HANDLE_PX`, the CSS side names
 *  EXACTLY one shared `.col-resize`/`.inspector-resize` width, and the two
 *  numbers are equal. Every other combination (missing, duplicated, or
 *  simply disagreeing) is invalid, with a `reason` a test can assert on. */
function resizeHandleContractStatus(jsSource, cssSource) {
  const jsValues = extractHandlePxValues(jsSource);
  const cssValues = extractSharedResizeWidthPx(cssSource);
  if (jsValues.length !== 1) return { ok: false, reason: 'js-ambiguous', jsValues, cssValues };
  if (cssValues.length !== 1) return { ok: false, reason: 'css-ambiguous', jsValues, cssValues };
  if (jsValues[0] !== cssValues[0]) return { ok: false, reason: 'mismatch', jsValues, cssValues };
  return { ok: true, value: jsValues[0] };
}

describe('#592 resize-handle thickness contract (real production files)', () => {
  it('exactly one HANDLE_PX declaration exists in app-shell.ts', () => {
    expect(extractHandlePxValues(realAppShellSource())).toHaveLength(1);
  });

  it('.col-resize and .inspector-resize are governed by exactly one shared width declaration', () => {
    expect(extractSharedResizeWidthPx(realStylesSource())).toHaveLength(1);
  });

  it('the CSS shared width exactly equals HANDLE_PX', () => {
    const status = resizeHandleContractStatus(realAppShellSource(), realStylesSource());
    expect(status.ok).toBe(true);
    expect(status.value).toBe(extractHandlePxValues(realAppShellSource())[0]);
  });
});

describe('#592 resize-handle thickness contract sabotage (synthetic — independent of the real files)', () => {
  const CLEAN_JS = 'const HANDLE_PX = 7;\n';
  const CLEAN_CSS = '.col-resize, .inspector-resize { width: 7px; cursor: col-resize; }\n';

  it('the clean baseline pair is valid (sanity check on the extractors themselves)', () => {
    expect(resizeHandleContractStatus(CLEAN_JS, CLEAN_CSS)).toMatchObject({ ok: true, value: 7 });
  });

  it('JS changes to 8 while CSS remains 7px: fails', () => {
    const status = resizeHandleContractStatus('const HANDLE_PX = 8;\n', CLEAN_CSS);
    expect(status).toMatchObject({ ok: false, reason: 'mismatch', jsValues: [8], cssValues: [7] });
  });

  it('CSS changes to 8px while JS remains 7: fails', () => {
    const status = resizeHandleContractStatus(CLEAN_JS, '.col-resize, .inspector-resize { width: 8px; }\n');
    expect(status).toMatchObject({ ok: false, reason: 'mismatch', jsValues: [7], cssValues: [8] });
  });

  it('.col-resize and .inspector-resize stop sharing the intended declaration: fails', () => {
    // Two INDEPENDENT single-class rules, not one shared rule — the P1 fix
    // (extraction is now OR-based, not AND-based) means each is now its own
    // "could target either resize class" width declaration, so this is
    // still `css-ambiguous` (length !== 1), just via [7, 7] rather than the
    // old AND-only extractor's `[]` (which only ever looked at the combined
    // rule and never saw either standalone declaration at all).
    const css = '.col-resize { width: 7px; }\n.inspector-resize { width: 7px; }\n';
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 7] });
  });

  it('the JS constant is missing entirely: fails', () => {
    const status = resizeHandleContractStatus('const OTHER = 7;\n', CLEAN_CSS);
    expect(status).toMatchObject({ ok: false, reason: 'js-ambiguous', jsValues: [] });
  });

  it('the JS constant is duplicated: fails', () => {
    const js = 'const HANDLE_PX = 7;\nfunction f() { const HANDLE_PX = 9; return HANDLE_PX; }\n';
    const status = resizeHandleContractStatus(js, CLEAN_CSS);
    expect(status).toMatchObject({ ok: false, reason: 'js-ambiguous', jsValues: [7, 9] });
  });

  it('the CSS width is missing from the shared rule: fails', () => {
    const css = '.col-resize, .inspector-resize { cursor: col-resize; }\n';
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [] });
  });

  it('the CSS width is ambiguous (declared twice in the same shared rule): fails', () => {
    const css = '.col-resize, .inspector-resize { width: 7px; width: 9px; }\n';
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 9] });
  });

  // P1 (accepted, PR #672 review pass 1): a standalone or media-scoped
  // single-class override rule used to be invisible to
  // `extractSharedResizeWidthPx` (it only looked at rules naming BOTH
  // classes together), so this exact drift — the browser renders the
  // inspector handle at a DIFFERENT width than `HANDLE_PX` reserves — passed
  // the contract silently.

  it('a later standalone .inspector-resize override with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.inspector-resize { width: 8px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 8] });
  });

  it('a standalone .col-resize override with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.col-resize { width: 9px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 9] });
  });

  it('a media-query-scoped .inspector-resize override with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}@media (max-width: 768px) {\n  .inspector-resize { width: 10px; }\n}\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 10] });
  });

  it('a standalone override that happens to repeat the SAME width still fails (no single-source-of-truth exception)', () => {
    const css = `${CLEAN_CSS}.inspector-resize { width: 7px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 7] });
  });

  it('a comment-only mention of HANDLE_PX does not count as a declaration', () => {
    const js = '// const HANDLE_PX = 7; (old value)\n/* const HANDLE_PX = 9; */\n';
    expect(extractHandlePxValues(js)).toEqual([]);
  });

  it('a comment-only mention of the shared width rule does not count as a declaration', () => {
    const css = '/* .col-resize, .inspector-resize { width: 7px; } */\n';
    expect(extractSharedResizeWidthPx(css)).toEqual([]);
  });

  // #592 review pass 3: a COMPOUND selector (two classes on the same
  // element, `.inspector-resize.dragging`) or a DESCENDANT selector
  // (`.shell .inspector-resize`) still targets `.inspector-resize` — and can
  // still win the real cascade for it — but `selectors.includes('.inspector-
  // resize')`'s exact-string-list membership check made both invisible to
  // the extractor entirely, so a `width` override written either way never
  // even reached the `cssValues.length !== 1` gate.

  it('a compound-selector override (.inspector-resize.dragging) with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.inspector-resize.dragging { width: 8px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 8] });
  });

  it('a compound-selector override with the classes in the opposite order (.dragging.inspector-resize) fails', () => {
    const css = `${CLEAN_CSS}.dragging.inspector-resize { width: 9px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 9] });
  });

  it('a descendant-selector override (.shell .inspector-resize) with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.shell .inspector-resize { width: 10px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 10] });
  });

  it('a compound-selector override on .col-resize (.col-resize.active) with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.col-resize.active { width: 11px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 11] });
  });

  it('a same-prefix but DIFFERENT class name is never mistaken for a match (.col-resized)', () => {
    // Sanity check on the negative-lookahead boundary: `.col-resized` must
    // never be treated as targeting `.col-resize`.
    const css = `${CLEAN_CSS}.col-resized { width: 99px; }\n`;
    expect(extractSharedResizeWidthPx(css)).toEqual([7]);
  });

  it('a pseudo-CLASS compound override (.inspector-resize:hover) with a DIFFERENT width fails', () => {
    // Unlike a pseudo-ELEMENT (below), `:hover` still styles the SAME
    // element's own box — a real override this contract must catch.
    const css = `${CLEAN_CSS}.inspector-resize:hover { width: 12px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 12] });
  });

  it('a pseudo-ELEMENT selector (.col-resize::before) is never mistaken for the handle\'s own width', () => {
    // Real shape from src/styles.css: `.col-resize::before { width: 1px; … }`
    // styles the decorative `::before` pseudo-element — an entirely separate
    // generated box with its own independent width, not an override of the
    // handle element's OWN width, so it correctly stays out of scope.
    const css = `${CLEAN_CSS}.col-resize::before { width: 1px; }\n`;
    expect(extractSharedResizeWidthPx(css)).toEqual([7]);
  });

  it('a compound-then-pseudo-element selector (.col-resize.dragging::before) is never mistaken for the handle\'s own width', () => {
    const css = `${CLEAN_CSS}.col-resize.dragging::before { width: 1px; }\n`;
    expect(extractSharedResizeWidthPx(css)).toEqual([7]);
  });
});
