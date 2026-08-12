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

/** Decode real CSS identifier ESCAPE SEQUENCES — a backslash followed by 1-6
 *  hex digits (optionally consuming one trailing whitespace character that
 *  terminates the hex run, per the CSS spec) is that Unicode code point; a
 *  backslash followed by any other single character is that literal
 *  character. Mirrors the identically-specified `decodeCssEscapes` in
 *  `build/lib/check-legacy-owners.mjs` (added there for the general
 *  `shell-fixed-position` CSS scanner, #592 review pass 3) — duplicated here
 *  rather than imported: that module exports no such helper, and this file's
 *  own established precedent (`flatCssRules`'s own doc comment above) is to
 *  duplicate the ONE specific need rather than reuse the general
 *  architecture-guard scanner for an unrelated, independent test. Applied
 *  ONLY to an already-split selector token or property/value text right
 *  before a comparison, never to the raw buffer used for brace/comma/colon
 *  SPLITTING — a decoded escape could change the text's length or introduce
 *  a real delimiter character, which must never disturb where a rule or
 *  declaration was actually delimited (#592 review pass 3: without this,
 *  real, browser-equivalent CSS like `.inspector-resize { \77idth: 8px; }`
 *  — `\77` = `w` — stays textually distinct from `'width'` and silently
 *  escapes this contract's own width comparison). */
function decodeCssIdentifierEscapes(text) {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_m, hex, literal) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return Number.isNaN(code) ? '' : String.fromCodePoint(code);
    }
    return literal ?? '';
  });
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
 *  never matched any of these either). `selector` is decoded
 *  (`decodeCssIdentifierEscapes`) before either check (#592 review pass 3),
 *  so an escaped class-name spelling is recognized identically to its
 *  unescaped form. */
function selectorTargetsResizeHandleClass(selector, className) {
  const decoded = decodeCssIdentifierEscapes(selector);
  if (decoded.includes('::')) return false;
  return new RegExp(`\\.${className}(?![\\w-])`).test(decoded);
}

/** Every `width: <value>` declaration's own numeric-px value, declared by ANY
 *  flat rule whose selector list names `.col-resize` and/or `.inspector-
 *  resize` — together (the rule that governs both classes' shared width),
 *  alone (a more-specific, later-declared, or media-query-scoped override
 *  that could still win the real cascade for just one of the two classes
 *  even though it never mentions the other — the P1 gap `flatCssRules`'s own
 *  brace-agnostic regex already sees through one level of `@media { … }`
 *  nesting for: an inner flat rule is matched on its own, the outer at-rule
 *  prelude is simply skipped as unmatched text), OR as part of a COMPOUND/
 *  DESCENDANT selector naming either class (`selectorTargetsResizeHandleClass`,
 *  the pass-3 fix — a bare-class-list membership check alone missed
 *  `.inspector-resize.dragging { width: 8px; }` and `.shell .inspector-resize
 *  { width: 8px; }` entirely, so either override silently escaped this
 *  contract). EVERY matching `width:` declaration contributes exactly one
 *  entry — a real numeric px value (`7`, `8px !important` → `8`, the
 *  `!important` suffix never changes the browser's real geometry so it never
 *  changes what this contract extracts either) when the declared value IS a
 *  plain `<number>px` (optionally `!important`), or `NaN` for anything else
 *  the browser's cascade could still render as a real width but this
 *  contract cannot statically reduce to one comparable number — `calc(...)`,
 *  a custom-property `var(...)`, or any other non-literal value (P1 follow-
 *  up, ChatGPT PR #672 pass 1: the prior regex silently SKIPPED any `width:`
 *  value that wasn't already an exact `<number>px;` token, so a real,
 *  differently-valued `!important`/`calc()`/`var()` override on either
 *  resize class was invisible to this extractor — the SAME class of
 *  "silently skip instead of fail closed" bug the descendant/compound-
 *  selector fix above (pass 3) already closed for the SELECTOR side of this
 *  contract, just still open on the VALUE side). Order-independent; the
 *  contract below requires EXACTLY one declaration overall, so ANY second
 *  `width:` declaration on either class — standalone, compound, descendant,
 *  media-scoped, `!important`, or a non-literal value — makes the count 2+
 *  and the contract fails closed (`css-ambiguous`) instead of silently
 *  reading only the grouped rule's own value while the browser's real
 *  cascade could render a completely different pixel width; a SOLE
 *  `calc()`/`var()` declaration (no clean numeric sibling at all) is a
 *  single `NaN` entry, which the exact-equality contract below can never
 *  treat as a match for the real `HANDLE_PX` either. The value-side regex's
 *  terminator matches a trailing `;` OR the end of the rule body itself
 *  (`(?:;|$)`, P1 follow-up, ChatGPT PR #672 review pass 2): a real CSS
 *  engine terminates a rule's LAST declaration at the closing `}` even with
 *  no trailing `;` (`.inspector-resize { width: 8px }`), but the prior
 *  regex required a literal `;` — so that declaration contributed ZERO
 *  entries, not even the NaN fail-closed entry a non-literal value gets,
 *  silently passing the contract even though the real cascade renders that
 *  width. Each declaration's PROPERTY NAME (the text before its own `:`) is
 *  decoded (`decodeCssIdentifierEscapes`) before comparing to `'width'`
 *  (#592 review pass 3): a real CSS identifier escape in the property name
 *  (`\77idth: 8px;` — `\77` = `w`, a spec-legal spelling every real browser
 *  parses identically to `width: 8px;`) previously stayed textually
 *  distinct from `'width'` and silently skipped this extractor entirely —
 *  the same "lexical trickery hides a declaration" gap `decodeCssEscapes`
 *  already closes for the general `shell-fixed-position` CSS scanner in
 *  `build/lib/check-legacy-owners.mjs`, never applied to this INDEPENDENT
 *  extractor. Declarations are found by splitting the rule body on `;`
 *  (rather than the previous single `width\s*:` regex) so the property-name
 *  text is available on its own for decoding before the comparison — the
 *  VALUE side's own decode-then-match shape (numeric px / `!important` /
 *  fail-closed `NaN`) is unchanged. */
function extractSharedResizeWidthPx(cssSource) {
  const values = [];
  for (const rule of flatCssRules(cssSource)) {
    const targets = rule.selectors.some(
      (s) => selectorTargetsResizeHandleClass(s, 'col-resize') || selectorTargetsResizeHandleClass(s, 'inspector-resize'),
    );
    if (!targets) continue;
    for (const decl of rule.body.split(';')) {
      const colonIdx = decl.indexOf(':');
      if (colonIdx === -1) continue;
      const prop = decodeCssIdentifierEscapes(decl.slice(0, colonIdx)).trim().toLowerCase();
      if (prop !== 'width') continue;
      const rawValue = decodeCssIdentifierEscapes(decl.slice(colonIdx + 1)).trim();
      const numeric = /^(-?\d+(?:\.\d+)?)px(?:\s*!\s*important)?$/i.exec(rawValue);
      values.push(numeric ? Number(numeric[1]) : NaN);
    }
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

  // P1 follow-up (accepted, ChatGPT PR #672 review pass 1): the value-side
  // regex required an EXACT `<number>px;` token with nothing else between
  // the number and the semicolon, so a `!important` suffix or a non-literal
  // value (`calc(...)`, `var(...)`) was silently SKIPPED rather than counted
  // — the real browser cascade still applies these declarations (an
  // `!important` value WINS over a normal one; `calc()`/`var()` compute to
  // some real pixel width), but the extractor never even saw them, so the
  // contract stayed green while a real, differently-valued override sat
  // right there in the CSS.

  it('a later standalone !important override with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.inspector-resize { width: 8px !important; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 8] });
  });

  it('an !important override with no space before the bang is still counted', () => {
    const css = `${CLEAN_CSS}.col-resize { width: 9px!important; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 9] });
  });

  it('a calc() override is counted as an unconvertible (NaN) value, not silently skipped', () => {
    const css = `${CLEAN_CSS}.inspector-resize { width: calc(7px + 1px); }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('css-ambiguous');
    expect(status.cssValues).toHaveLength(2);
    expect(status.cssValues[0]).toBe(7);
    expect(Number.isNaN(status.cssValues[1])).toBe(true);
  });

  it('a var(--custom-property) override is counted as an unconvertible (NaN) value, not silently skipped', () => {
    const css = `${CLEAN_CSS}.col-resize { width: var(--handle-width); }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status.ok).toBe(false);
    expect(status.reason).toBe('css-ambiguous');
    expect(status.cssValues).toHaveLength(2);
    expect(status.cssValues[0]).toBe(7);
    expect(Number.isNaN(status.cssValues[1])).toBe(true);
  });

  it('a later standalone override with NO trailing semicolon (end-of-rule-body terminator) is still counted', () => {
    // P1 follow-up (ChatGPT PR #672 review pass 2): the value-side regex
    // required a literal trailing `;`, but a real CSS engine terminates the
    // LAST declaration in a rule at the closing `}` just as validly — this
    // declaration must not silently contribute zero entries.
    const css = `${CLEAN_CSS}.inspector-resize { width: 8px }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 8] });
  });

  it('a SOLE var(...) declaration (no clean numeric sibling) is a single unconvertible NaN value, never a false match', () => {
    const css = '.col-resize, .inspector-resize { width: var(--handle-width); }\n';
    const values = extractSharedResizeWidthPx(css);
    expect(values).toHaveLength(1);
    expect(Number.isNaN(values[0])).toBe(true);
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status.ok).toBe(false); // NaN !== 7 either way — never a silent pass
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

  // #592 review pass 3: real CSS identifier ESCAPE SEQUENCES in the
  // PROPERTY NAME — `\77idth` (a hex escape: `\77` = `w`) or `\width` (a
  // single-character escape: `\w` = literal `w`) — are both, per the CSS
  // spec, exactly equivalent to plain `width` in every real browser, but the
  // prior regex matched only the literal text `width` and silently skipped
  // either escaped spelling entirely, leaving a real, differently-valued
  // override invisible to this contract.

  it('an escaped property name using a hex CSS identifier escape (\\77idth) with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.inspector-resize { \\77idth: 8px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 8] });
  });

  it('an escaped property name using a single-character CSS identifier escape (\\width) with a DIFFERENT width fails', () => {
    const css = `${CLEAN_CSS}.col-resize { \\width: 9px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 9] });
  });

  it('an escaped selector class name (.inspector-re\\size, equivalent to .inspector-resize) with a DIFFERENT width fails', () => {
    // `\s` is a single-character escape (`s` is not a hex digit), decoding
    // to literal `s` — unlike `\e` (which real CSS parses as the HEX escape
    // for code point U+000E, since `e` IS a valid hex digit), so `s` is
    // deliberately the escaped character here.
    const css = `${CLEAN_CSS}.inspector-re\\size { width: 10px; }\n`;
    const status = resizeHandleContractStatus(CLEAN_JS, css);
    expect(status).toMatchObject({ ok: false, reason: 'css-ambiguous', cssValues: [7, 10] });
  });
});
