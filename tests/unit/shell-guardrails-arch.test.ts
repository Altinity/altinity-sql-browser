// Issue #592 — lock in what #586 ("one overlay-lifecycle implementation") and
// #587 ("a registry-driven panel model") established, mechanically, so the
// six-copy-pasted-overlays problem #586 fixed cannot silently regrow the same
// way it grew the first time. Three real-parser/lexer-backed checks, sharing
// this repo's established idiom (`findSurfaceLifecycleSourceContractViolations`,
// #643): real TypeScript AST for the two source-level rules
// (`findShellGuardrailSourceContractViolations`, one shared parser batch for
// BOTH — Architecture decision 4), and a focused CSS lexical scanner (no CSS
// parser dependency — `scanFixedPositionDeclarations`/
// `findShellFixedPositionViolations`, Architecture decision 2) for the CSS
// rule. This file follows `surface-lifecycle-arch.test.ts`'s own sibling
// shape: a live-tree zero-violation baseline PLUS synthetic fixtures/sabotage
// for every case the plan's own Test Matrix lists — never guessed, every
// fingerprint below traces to a real, reviewed occurrence in the current tree
// (see `build/lib/check-legacy-owners.mjs`'s own `SHELL_BODY_MOUNT_POLICY`/
// `SHELL_CAPTURE_ESCAPE_POLICY`/`SHELL_FIXED_POSITION_POLICY`).
//
// Stays `.ts` (not `.js`) for the same reason `surface-lifecycle-arch.test.ts`
// and `side-panel-source-contract.test.ts` do: it consumes the strict
// `.d.mts` declaration boundary over the `.mjs` implementation, so a caller
// error is caught by `tsc --noEmit`, not just at runtime.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findShellGuardrailSourceContractViolations,
  findShellFixedPositionViolations,
  findShellFixedPositionMissingBaselineViolations,
  scanFixedPositionDeclarations,
} from '../../build/lib/check-legacy-owners.mjs';
import type {
  SourceContractViolation, ShellGuardrailSourceEntry, FixedPositionDeclaration,
} from '../../build/lib/check-legacy-owners.mjs';

const here = dirname(fileURLToPath(import.meta.url)); // tests/unit
const root = join(here, '..', '..'); // repo root
const srcDir = join(root, 'src');

function listSourceFiles(): string[] {
  return readdirSync(srcDir, { recursive: true })
    .filter((rel) => /\.(ts|js)$/.test(rel))
    // Generated code is never hand-edited and can't legally reference these
    // production constructs anyway — excluded for signal, not correctness
    // (matches surface-lifecycle-arch.test.ts's own exclusion).
    .filter((rel) => !rel.startsWith('generated' + '/') && !rel.includes(`${'generated'}/`))
    .map((rel) => 'src/' + rel.split('\\').join('/'));
}

function rulesOf(vs: SourceContractViolation[]): string[] {
  return vs.map((v) => v.rule);
}

// ── Live-tree baseline ───────────────────────────────────────────────────────
// Mandatory proof that the policy tables and production `check:arch` operate
// on the SAME baseline: zero #592 violations over the complete current
// scanned tree.

describe('#592 shell guardrails: live-tree baseline', () => {
  let tsViolations: SourceContractViolation[];
  let cssViolations: SourceContractViolation[];

  beforeAll(() => {
    const files = listSourceFiles();
    const sources: ShellGuardrailSourceEntry[] = files.map((relPath) => ({
      filename: relPath,
      source: readFileSync(join(root, relPath), 'utf8'),
    }));
    tsViolations = findShellGuardrailSourceContractViolations(sources);
    const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
    cssViolations = findShellFixedPositionViolations(css, 'src/styles.css');
  }, 10000);

  it('no shell-body-mount violation exists anywhere in the current tree', () => {
    expect(tsViolations.filter((v) => v.rule === 'shell-body-mount')).toEqual([]);
  });

  it('no shell-capture-escape violation exists anywhere in the current tree', () => {
    expect(tsViolations.filter((v) => v.rule === 'shell-capture-escape')).toEqual([]);
  });

  it('no shell-fixed-position violation exists in src/styles.css', () => {
    expect(cssViolations).toEqual([]);
  });
});

// ── Shared synthetic-fixture scope builder ──────────────────────────────────
// Every #592 policy entry keys on (filename, scope PATH) — see
// `enclosingScopePath`'s own doc comment in check-legacy-owners.mjs. Real
// scope names are one of three shapes: a plain named function
// (`function openMenu() { … }`), the literal placeholder `'mount'` (an
// object-literal `mount:` property, matching every real `openInDetachedTab`
// caller), or the literal placeholder `'<anonymous>'` (an IIFE arrow, matching
// `withDocument(doc, () => { … })`'s real shape). `wrapScope` nests `inner`
// through exactly that chain, outermost first, so a fixture reproduces the
// SAME scope path the real occurrence has — never a hand-guessed approximation.

function wrapScope(names: readonly string[], inner: string): string {
  let code = inner;
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i];
    if (name === '<anonymous>') {
      code = `(() => {\n${code}\n})();`;
    } else if (name === 'mount') {
      code = `const _m = { mount: (ctx) => {\n${code}\n} };`;
    } else {
      code = `function ${name}() {\n${code}\n}`;
    }
  }
  return code;
}

function shellViolations(sources: ShellGuardrailSourceEntry[]): SourceContractViolation[] {
  return findShellGuardrailSourceContractViolations(sources);
}

function bodyMountRulesFor(filename: string, scopePath: readonly string[], body: string): string[] {
  const source = wrapScope(scopePath, body);
  return rulesOf(shellViolations([{ filename, source }]).filter((v) => v.rule === 'shell-body-mount'));
}

/** Prefix `body` with `const <alias> = document;` — every fixture below that
 *  addresses a Document through a bare local name (`doc`, `d`, `childDoc`,
 *  `mainDoc`) must first ESTABLISH that alias in its own synthetic snippet
 *  (a fixture has no surrounding real file supplying a typed parameter), or
 *  the analyzer correctly does NOT recognize the receiver as a Document at
 *  all — which would make a positive case pass, and a sabotage case fail,
 *  for the WRONG reason (no candidate detected) rather than the intended one
 *  (a candidate detected and correctly classified). `deps.document`/
 *  `opts.document`/bare `document`/`window` receivers need no such prefix:
 *  they resolve structurally, with no alias declaration required.
 */
function withDocAlias(alias: string, body: string): string {
  return `const ${alias} = document;\n${body}`;
}

// ── Body-mount positive cases ────────────────────────────────────────────────
// Every current sanctioned shape (`SHELL_BODY_MOUNT_POLICY`'s own 11 entries),
// each reproduced as a minimal synthetic fixture under its real filename.

describe('#592 shell-body-mount: positive characterization (sanctioned current shapes)', () => {
  const cases: Array<[string, string, readonly string[], string]> = [
    ['SurfaceLifecycle-backed results overlay (openCellDetail)', 'src/ui/results.ts', ['openCellDetail', '<anonymous>'],
      withDocAlias('doc', "openSurfaceLifecycle({ document: doc }); doc.body.appendChild(backdrop);")],
    ['dialog-shell', 'src/ui/dialog-shell.ts', ['openDialogShell'], withDocAlias('doc', 'doc.body.appendChild(backdrop);')],
    ['popover anchored-dialog family', 'src/ui/popover.ts', ['openAnchoredDialog'],
      withDocAlias('d', 'd.body.appendChild(overlay); d.body.appendChild(dialog);')],
    ['popover anchored-popover family', 'src/ui/popover.ts', ['createAnchoredPopovers', 'open'],
      'deps.document.body.appendChild(node);'],
    ['toast', 'src/ui/toast.ts', ['flashToast'], withDocAlias('doc', 'doc.body.appendChild(el);')],
    ['detached child-document mount', 'src/ui/detached-view.ts', ['openAsTab', '<anonymous>'],
      withDocAlias('childDoc', 'childDoc.body.appendChild(panel);')],
    ['detached main-document fallback', 'src/ui/detached-view.ts', ['openAsOverlay', '<anonymous>'],
      withDocAlias('mainDoc', 'mainDoc.body.appendChild(backdrop);')],
    ['menu', 'src/ui/menu.ts', ['openMenu'],
      withDocAlias('doc', 'doc.body.appendChild(overlay); doc.body.appendChild(menu);')],
    ['shortcuts modal', 'src/ui/shortcuts.ts', ['openShortcuts'], withDocAlias('doc', 'doc.body.appendChild(backdrop);')],
    ['export-progress surface', 'src/ui/app.ts', ['createApp', 'showExportProgress'],
      withDocAlias('doc', 'doc.body.appendChild(el);')],
    ['temporary download-anchor utility', 'src/ui/app.ts', ['createApp', 'downloadFile'],
      withDocAlias('doc', 'doc.body.appendChild(a);')],
  ];
  for (const [label, filename, scopePath, body] of cases) {
    it(`${label} passes`, () => {
      expect(bodyMountRulesFor(filename, scopePath, body)).toEqual([]);
    });
  }

  it('comments/string literals containing body-append text remain clean', () => {
    const found = bodyMountRulesFor('src/ui/_lookalike-mount.ts', ['openLookalikeMount'], [
      "// doc.body.appendChild(fake);",
      "const s = 'doc.body.appendChild(fake)';",
      'const n = 1;',
    ].join('\n'));
    expect(found).toEqual([]);
  });
});

// ── Body-mount sabotage cases ─────────────────────────────────────────────

describe('#592 shell-body-mount: sabotage (each must fail)', () => {
  const NEW_FILE = 'src/ui/_sabotage-body-mount.ts';

  const receiverCases: Array<[string, string]> = [
    ['document.body.appendChild(panel)', 'document.body.appendChild(panel);'],
    ['document.body.append(panel)', 'document.body.append(panel);'],
    ["doc.body.appendChild(panel) (doc: Document parameter)", 'function f(doc: Document) { doc.body.appendChild(panel); }'],
    ['window.document.body.appendChild(panel)', 'window.document.body.appendChild(panel);'],
    ['childDoc.body.appendChild(panel) (childDoc: Document parameter)',
      'function f(childDoc: Document) { childDoc.body.appendChild(panel); }'],
    ['mainDoc.body.appendChild(panel) (mainDoc: Document parameter)',
      'function f(mainDoc: Document) { mainDoc.body.appendChild(panel); }'],
    ['deps.document.body.appendChild(panel)', 'deps.document.body.appendChild(panel);'],
    ["bracket-property spelling doc['body']['appendChild'](panel)",
      "function f(doc: Document) { doc['body']['appendChild'](panel); }"],
    ['const body = childDoc.body; body.appendChild(panel)',
      'function f(childDoc: Document) { const body = childDoc.body; body.appendChild(panel); }'],
    ['simple propagated body alias (const b = body; b.appendChild(panel))',
      'function f(childDoc: Document) { const body = childDoc.body; const b = body; b.appendChild(panel); }'],
  ];
  for (const [label, body] of receiverCases) {
    it(`${label} fails`, () => {
      const source = `function openRogue() {\n${body}\n}`;
      const found = shellViolations([{ filename: NEW_FILE, source }]).filter((v) => v.rule === 'shell-body-mount');
      expect(found.length).toBeGreaterThan(0);
    });
  }

  it('a second mount inside an otherwise approved scope fails (only the excess one)', () => {
    const found = bodyMountRulesFor('src/ui/toast.ts', ['flashToast'],
      withDocAlias('doc', 'doc.body.appendChild(el); doc.body.appendChild(doc.createElement("div"));'));
    expect(found).toEqual(['shell-body-mount']);
  });

  it('a new mount elsewhere in an approved FILE fails (exceptions are not filename-wide)', () => {
    const found = bodyMountRulesFor('src/ui/toast.ts', ['someOtherFunction'], withDocAlias('doc', 'doc.body.appendChild(el);'));
    expect(found).toEqual(['shell-body-mount']);
  });

  it('removing openSurfaceLifecycle(...) from a mount whose permission depends on it fails', () => {
    // Same fingerprint as the SurfaceLifecycle-backed positive case above,
    // but WITHOUT the openSurfaceLifecycle(...) call in the same scope.
    const found = bodyMountRulesFor('src/ui/results.ts', ['openCellDetail', '<anonymous>'],
      withDocAlias('doc', 'doc.body.appendChild(backdrop);'));
    expect(found).toEqual(['shell-body-mount']);
  });
});

// ── Body-mount missing-baseline-entry sabotage (P1, PR #672 review pass 1) ──
// The prior implementation only ever flagged EXCESS occurrences in a scope
// that still had at least one candidate — a scope whose approved mount
// disappeared ENTIRELY produced zero violations, comparing the policy and
// the discovered candidates as an allowlist in only one direction.

describe('#592 shell-body-mount: missing-baseline-entry sabotage (each must fail)', () => {
  it('an approved scope that loses its ONLY frozen body-mount occurrence fails', () => {
    // src/ui/toast.ts's flashToast is approved for exactly 1 body mount —
    // remove it entirely (an empty scope body) rather than adding an excess.
    const found = bodyMountRulesFor('src/ui/toast.ts', ['flashToast'], '');
    expect(found).toEqual(['shell-body-mount']);
  });

  it('an approved scope that drops from 2 approved occurrences to 1 fails', () => {
    // src/ui/menu.ts's openMenu is approved for exactly 2 — keep only 1.
    const found = bodyMountRulesFor('src/ui/menu.ts', ['openMenu'], withDocAlias('doc', 'doc.body.appendChild(overlay);'));
    expect(found).toEqual(['shell-body-mount']);
  });
});

// ── Body-mount same-file scope-shadowing sabotage (P1, PR #672 review pass 1) ──
// The alias resolvers used to collect bindings by bare identifier across the
// ENTIRE source file (one flat last-write-wins Map), not lexically — a later
// sibling/nested same-named binding in an unrelated scope could silently
// erase an earlier one, hiding a real violation. These fixtures put TWO
// scopes with the SAME local names in ONE file (`shellViolations` operates
// per-file, so `bodyMountRulesFor`'s single-scope wrapper can't reproduce
// this — the source is built by hand instead).

describe('#592 shell-body-mount: same-file scope-shadowing sabotage (each must fail)', () => {
  it('a later sibling doc: Window function does not erase an earlier doc: Document body mount', () => {
    const source = [
      'function sneaky(doc: Document) { doc.body.appendChild(panel); }',
      'function unrelated(doc: Window) { }',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-shadow-doc-a.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found.length).toBeGreaterThan(0);
  });

  it('the same fixture with declaration order reversed still detects the violation', () => {
    // Proves the fix is genuinely scope-aware, not an artifact of which
    // declaration happens to come last in source order.
    const source = [
      'function unrelated(doc: Window) { }',
      'function sneaky(doc: Document) { doc.body.appendChild(panel); }',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-shadow-doc-b.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found.length).toBeGreaterThan(0);
  });
});

// ── Body-mount nested block-local shadowing sabotage (review pass 2) ───────
// One level finer than the #672 P1 same-FUNCTION shadowing fix above: a
// block-local `let`/`const` (an `if`/loop/bare `{ }` body, never a nested
// function) used to collapse into the SAME per-function alias bucket as an
// outer parameter of the same name, so the block-local shadow could silently
// erase (or be silently erased by) a real occurrence anywhere else in that
// same function — regardless of whether the real occurrence is inside or
// outside the shadow's own block.

describe('#592 shell-body-mount: nested block-local shadowing sabotage (each must fail)', () => {
  it('a block-local doc: Window shadow does not hide an outer doc: Document body mount AFTER the block', () => {
    const source = [
      'function openThing(doc: Document) {',
      '  if (c) {',
      '    const doc: Window = getPopup();',
      '    doc.close();',
      '  }',
      '  doc.body.appendChild(panel);',
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-block-shadow-doc-a.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found.length).toBeGreaterThan(0);
  });

  it('a block-local doc: Window shadow does not hide an outer doc: Document body mount BEFORE the block', () => {
    const source = [
      'function openThing(doc: Document) {',
      '  doc.body.appendChild(panel);',
      '  if (c) {',
      '    const doc: Window = getPopup();',
      '    doc.close();',
      '  }',
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-block-shadow-doc-b.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found.length).toBeGreaterThan(0);
  });

  it('the block-local doc: Window shadow correctly applies to a mount made INSIDE its own block', () => {
    // Proves the fix is genuinely block-scoped, not merely "ignore inner
    // shadows": a body-mount attempt through the SAME name INSIDE the block
    // resolves against the block-local Window, not the outer Document, and
    // is correctly NOT flagged.
    const source = [
      'function openThing(doc: Document) {',
      '  if (c) {',
      '    const doc: Window = getPopup();',
      '    doc.body.appendChild(panel);',
      '  }',
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-block-shadow-doc-c.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found).toEqual([]);
  });
});

// ── Capture-Escape positive cases ───────────────────────────────────────────

function captureEscapeRulesFor(filename: string, scopePath: readonly string[], body: string): string[] {
  const source = wrapScope(scopePath, body);
  return rulesOf(shellViolations([{ filename, source }]).filter((v) => v.rule === 'shell-capture-escape'));
}

describe('#592 shell-capture-escape: positive characterization (sanctioned current shapes)', () => {
  const cases: Array<[string, string, readonly string[], string]> = [
    ['canonical SurfaceLifecycle', 'src/ui/surface-lifecycle.ts', ['openSurfaceLifecycle'],
      withDocAlias('doc', "const onKeyDown = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKeyDown, true);")],
    ['dialog exception', 'src/ui/dialog-shell.ts', ['openDialogShell'],
      withDocAlias('doc', "const onKey = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey, true);")],
    ['popover exception (anchored-dialog family)', 'src/ui/popover.ts', ['openAnchoredDialog'],
      withDocAlias('d', "const onKeyDown = (e) => { if (e.key === 'Escape') close(); }; d.addEventListener('keydown', onKeyDown, true);")],
    ['popover exception (anchored-popover family)', 'src/ui/popover.ts', ['createAnchoredPopovers', 'open'],
      "const onKey = (e) => { if (e.key === 'Escape') close(); }; deps.document.addEventListener('keydown', onKey, true);"],
    ['results.ts distinct Data Pane handler', 'src/ui/results.ts', ['expandDataPane', 'mount'],
      withDocAlias('doc', "const onKey = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey, true);")],
    ['explain-graph.ts pipeline handler', 'src/ui/explain-graph.ts', ['openPipelineFullscreen', 'mount'],
      withDocAlias('doc', "const onKey = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey, true);")],
    ['explain-graph.ts schema handler', 'src/ui/explain-graph.ts', ['openSchemaView', 'mount'],
      withDocAlias('doc', "const onKey = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey, true);")],
    ['menu.ts', 'src/ui/menu.ts', ['openMenu'],
      withDocAlias('doc', "const onKey = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey, true);")],
    ['dashboard-tile-gestures.ts grid-resize Escape cancellation', 'src/ui/dashboard-tile-gestures.ts',
      ['createTileGestureController', 'wireGridResize', '<anonymous>'],
      "const onKey = (ev) => { if (ev.key === 'Escape') cancel(); }; deps.document.addEventListener('keydown', onKey, true);"],
    ['dashboard-tile-gestures.ts tile-drag Escape cancellation', 'src/ui/dashboard-tile-gestures.ts',
      ['createTileGestureController', 'wireTileDrag', 'onPointerDown'],
      "const onKey = (ev) => { if (ev.key === 'Escape') cleanup(); }; deps.document.addEventListener('keydown', onKey, true);"],
    ['dashboard-chart-interaction.ts beginSelection chart-selection Escape cancellation',
      'src/ui/dashboard-chart-interaction.ts', ['createDashboardChartInteractionController', 'beginSelection'],
      "const onKey = (event) => { if (event.key === 'Escape') cancel(); }; opts.document.addEventListener('keydown', onKey, true);"],
  ];
  for (const [label, filename, scopePath, body] of cases) {
    it(`${label} passes`, () => {
      expect(captureEscapeRulesFor(filename, scopePath, body)).toEqual([]);
    });
  }

  it('a generic capture keydown handler with no Escape branch stays clean', () => {
    const found = captureEscapeRulesFor('src/ui/dashboard.ts', ['renderDashboard'],
      withDocAlias('doc', "const noteInteraction = () => { userInteracted = true; }; doc.addEventListener('keydown', noteInteraction, true);"));
    expect(found).toEqual([]);
  });

  it('a non-capture Escape listener (no third argument) stays clean', () => {
    const found = captureEscapeRulesFor('src/ui/_noncapture.ts', ['openSomething'],
      "const onKey = (e) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', onKey);");
    expect(found).toEqual([]);
  });

  // Proves the shorthand-capture fix (below) resolves the ALIASED value, not
  // merely "a capture key exists at all" — a shorthand reusing an in-scope
  // `false` stays provably non-capture.
  it('{ capture } shorthand reusing an in-scope false stays clean', () => {
    const found = captureEscapeRulesFor('src/ui/_noncapture-shorthand.ts', ['openSomethingElse'],
      "const onKey = (e) => { if (e.key === 'Escape') close(); }; const capture = false; document.addEventListener('keydown', onKey, { capture });");
    expect(found).toEqual([]);
  });

  it('comments/strings containing listener lookalikes stay clean', () => {
    const found = captureEscapeRulesFor('src/ui/_lookalike.ts', ['openLookalike'], [
      "// document.addEventListener('keydown', onKey, true);",
      "const s = \"document.addEventListener('keydown', onKey, true)\";",
      'const n = 1;',
    ].join('\n'));
    expect(found).toEqual([]);
  });
});

// ── Capture-Escape sabotage cases ───────────────────────────────────────────

describe('#592 shell-capture-escape: sabotage (each must fail)', () => {
  const escapeHandler = "const onKey = (e) => { if (e.key === 'Escape') close(); };";

  it("document.addEventListener('keydown', handler, true) with Escape semantics fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-a.ts', ['openRogueA'],
      `${escapeHandler} document.addEventListener('keydown', onKey, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('window equivalent fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-b.ts', ['openRogueB'],
      `${escapeHandler} window.addEventListener('keydown', onKey, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('opts.document equivalent OUTSIDE the exact approved chart-selection fingerprint fails', () => {
    // Real filename/receiver shape, but a DIFFERENT scope than beginSelection.
    const found = captureEscapeRulesFor('src/ui/dashboard-chart-interaction.ts',
      ['createDashboardChartInteractionController', 'someOtherMethod'],
      `${escapeHandler} opts.document.addEventListener('keydown', onKey, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it("{ capture: true } fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-c.ts', ['openRogueC'],
      `${escapeHandler} document.addEventListener('keydown', onKey, { capture: true });`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a simple capture-options alias fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-d.ts', ['openRogueD'],
      `${escapeHandler} const opts2 = { capture: true }; document.addEventListener('keydown', onKey, opts2);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  // #592 review pass 2: `resolveObjectCaptureLiteral` only ever recognized a
  // plain-identifier-keyed `capture` property; a string-literal key, a
  // computed string-literal key, or shorthand each fell through to the
  // "no capture key present" branch and resolved provably `false`, silently
  // bypassing the guard for a real capture-phase Escape listener.
  it("{ 'capture': true } (string-literal key) fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-string-key.ts', ['openRogueStringKey'],
      `${escapeHandler} document.addEventListener('keydown', onKey, { 'capture': true });`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it("{ ['capture']: true } (computed string-literal key) fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-computed-key.ts', ['openRogueComputedKey'],
      `${escapeHandler} document.addEventListener('keydown', onKey, { ['capture']: true });`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('{ capture } (shorthand, reusing an in-scope boolean) fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-shorthand.ts', ['openRogueShorthand'],
      `${escapeHandler} const capture = true; document.addEventListener('keydown', onKey, { capture });`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('an inline handler fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-e.ts', ['openRogueE'],
      "document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);");
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a local named FUNCTION DECLARATION handler fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-f.ts', ['openRogueF'],
      "function onKey(e) { if (e.key === 'Escape') close(); } document.addEventListener('keydown', onKey, true);");
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('an aliased Document/Window target fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-g.ts', ['openRogueG'],
      `${escapeHandler} const d = window; d.addEventListener('keydown', onKey, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it("event.key !== 'Escape' guard fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-h.ts', ['openRogueH'],
      "const onKey = (e) => { if (e.key !== 'Escape') return; close(); }; document.addEventListener('keydown', onKey, true);");
    expect(found).toEqual(['shell-capture-escape']);
  });

  it("event.code === 'Escape' fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-i.ts', ['openRogueI'],
      "const onKey = (e) => { if (e.code === 'Escape') close(); }; document.addEventListener('keydown', onKey, true);");
    expect(found).toEqual(['shell-capture-escape']);
  });

  it("switch (event.key) with an Escape case fails", () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-j.ts', ['openRogueJ'], [
      "const onKey = (e) => { switch (e.key) { case 'Escape': close(); break; default: break; } };",
      "document.addEventListener('keydown', onKey, true);",
    ].join('\n'));
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('an unresolved global capture-keydown handler fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-k.ts', ['openRogueK'],
      "document.addEventListener('keydown', getHandler(), true);");
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('unresolved capture options for an Escape keydown fails', () => {
    const found = captureEscapeRulesFor('src/ui/_sabotage-l.ts', ['openRogueL'],
      `${escapeHandler} document.addEventListener('keydown', onKey, computeOptions());`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a second listener inside results.ts (expandDataPane > mount) fails', () => {
    const found = captureEscapeRulesFor('src/ui/results.ts', ['expandDataPane', 'mount'], withDocAlias('doc',
      `${escapeHandler} doc.addEventListener('keydown', onKey, true);
       const onKey2 = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey2, true);`));
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a second listener inside explain-graph.ts (openSchemaView > mount) fails', () => {
    const found = captureEscapeRulesFor('src/ui/explain-graph.ts', ['openSchemaView', 'mount'], withDocAlias('doc',
      `${escapeHandler} doc.addEventListener('keydown', onKey, true);
       const onKey2 = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey2, true);`));
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a second listener inside menu.ts (openMenu) fails', () => {
    const found = captureEscapeRulesFor('src/ui/menu.ts', ['openMenu'], withDocAlias('doc',
      `${escapeHandler} doc.addEventListener('keydown', onKey, true);
       const onKey2 = (e) => { if (e.key === 'Escape') close(); }; doc.addEventListener('keydown', onKey2, true);`));
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a second listener in dashboard-chart-interaction.ts (beginSelection) fails', () => {
    const found = captureEscapeRulesFor('src/ui/dashboard-chart-interaction.ts',
      ['createDashboardChartInteractionController', 'beginSelection'],
      `${escapeHandler} opts.document.addEventListener('keydown', onKey, true);
       const onKey2 = (e) => { if (e.key === 'Escape') cancel(); }; opts.document.addEventListener('keydown', onKey2, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });

  it('a third gesture listener in dashboard-tile-gestures.ts (a new scope) fails', () => {
    const found = captureEscapeRulesFor('src/ui/dashboard-tile-gestures.ts',
      ['createTileGestureController', 'wireSomeOtherGesture'],
      `${escapeHandler} deps.document.addEventListener('keydown', onKey, true);`);
    expect(found).toEqual(['shell-capture-escape']);
  });
});

// ── Capture-Escape missing-baseline-entry sabotage (P1, PR #672 review pass 1) ──
// Same reverse-direction gap as `shell-body-mount`'s: the excess-only loop
// never visits a scope with zero remaining candidates, so a disappeared
// frozen Escape listener produced no violation at all.

describe('#592 shell-capture-escape: missing-baseline-entry sabotage (each must fail)', () => {
  it('an approved scope that loses its ONLY frozen capture-Escape listener fails', () => {
    // src/ui/menu.ts's openMenu is approved for exactly 1 capture-Escape
    // listener — remove it entirely (an empty scope body).
    const found = captureEscapeRulesFor('src/ui/menu.ts', ['openMenu'], '');
    expect(found).toEqual(['shell-capture-escape']);
  });
});

// ── Capture-Escape same-file scope-shadowing sabotage (P1, PR #672 review pass 1) ──
// Reproduces the reviewed capture-alias-overwrite and handler-shadowing
// cases: a same-named binding in an unrelated sibling or nested-below scope
// must never resolve (or de-resolve) a real scope's own capture options or
// handler. `shellViolations` is called directly (not through
// `captureEscapeRulesFor`) because these fixtures need TWO independent
// scopes in ONE file.

describe('#592 shell-capture-escape: same-file scope-shadowing sabotage (each must fail)', () => {
  it("a sibling scope's opts = false does not erase a real scope's { capture: true } alias", () => {
    const source = [
      'function real(doc: Document) {',
      "  const onKey = (e) => { if (e.key === 'Escape') close(); };",
      '  const opts = { capture: true };',
      "  doc.addEventListener('keydown', onKey, opts);",
      '}',
      'function other() {',
      '  const opts = false;',
      "  document.addEventListener('click', () => {}, opts);",
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-shadow-capture.ts', source }])
      .filter((v) => v.rule === 'shell-capture-escape');
    expect(found.length).toBeGreaterThan(0);
  });

  it("an unrelated nested helper's same-named local never resolves a real scope's addEventListener handler", () => {
    // `unrelatedHelper`'s own `onKey` sits textually BETWEEN the real
    // Escape-testing `onKey`'s declaration and its `addEventListener` use —
    // a nearest-preceding-by-POSITION (not by lexical scope) resolver picks
    // the wrong, non-Escape handler and the real violation goes undetected.
    const source = [
      'function real(doc: Document) {',
      "  const onKey = (e) => { if (e.key === 'Escape') close(); };",
      '  function unrelatedHelper() {',
      '    const onKey = (e) => { userInteracted = true; };',
      '  }',
      "  doc.addEventListener('keydown', onKey, true);",
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-shadow-handler.ts', source }])
      .filter((v) => v.rule === 'shell-capture-escape');
    expect(found.length).toBeGreaterThan(0);
  });
});

// ── Capture-Escape nested block-local shadowing sabotage (review pass 2) ────
// The same one-level-finer gap as `shell-body-mount`'s own block-shadowing
// sabotage above: a block-local (`if`/loop/bare `{ }`, never a nested
// function) alias or handler of the SAME name used to collapse into the same
// per-function bucket as a real scope's own capture-options alias or named
// handler, so the block-local shadow could silently overwrite (or be
// overwritten by) the real one — hiding the real violation entirely.

describe('#592 shell-capture-escape: nested block-local shadowing sabotage (each must fail)', () => {
  it("a block-local, unrelated capture-options alias does not erase a real scope's { capture: true } alias", () => {
    const source = [
      'function real(doc: Document) {',
      '  const opts = { capture: true };', // the real listener's own alias
      '  if (c) {',
      '    const opts = false;', // block-local shadow, unrelated listener
      "    document.addEventListener('click', () => {}, opts);",
      '  }',
      "  const onKey = (e) => { if (e.key === 'Escape') close(); };",
      "  doc.addEventListener('keydown', onKey, opts);", // must still resolve the OUTER alias
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-block-shadow-capture.ts', source }])
      .filter((v) => v.rule === 'shell-capture-escape');
    expect(found.length).toBeGreaterThan(0);
  });

  it("a block-local, unrelated named handler does not erase a real scope's Escape-testing handler", () => {
    const source = [
      'function real(doc: Document) {',
      "  const onKey = (e) => { if (e.key === 'Escape') close(); };", // the real handler
      '  if (c) {',
      '    const onKey = (e) => { userInteracted = true; };', // block-local shadow, unrelated
      "    document.addEventListener('click', onKey);",
      '  }',
      "  doc.addEventListener('keydown', onKey, true);", // must still resolve the OUTER handler
      '}',
    ].join('\n');
    const found = shellViolations([{ filename: 'src/ui/_sabotage-block-shadow-handler.ts', source }])
      .filter((v) => v.rule === 'shell-capture-escape');
    expect(found.length).toBeGreaterThan(0);
  });
});

// ── Fixed-position positive cases ───────────────────────────────────────────

describe('#592 shell-fixed-position: positive characterization', () => {
  it('a representative current root selector passes', () => {
    const css = '.auth-host { position: fixed; inset: 0; z-index: 120; }';
    expect(findShellFixedPositionViolations(css, 'src/styles.css')).toEqual([]);
  });

  it('the mobile .inspector-host rule under its current media context passes', () => {
    const css = '@media (max-width: 768px) {\n  .inspector-host { position: fixed; inset: 0; }\n}\n';
    expect(findShellFixedPositionViolations(css, 'src/styles.css')).toEqual([]);
  });

  it('the same selector under a DIFFERENT at-rule context is a NEW key (fails)', () => {
    const css = '@media (max-width: 999px) {\n  .inspector-host { position: fixed; inset: 0; }\n}\n';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('shell-fixed-position');
  });

  it('comma-selector normalization is deterministic regardless of source spacing', () => {
    const a = scanFixedPositionDeclarations('.a,.b{position:fixed;}');
    const b = scanFixedPositionDeclarations('.a  ,   .b   {\n  position: fixed;\n}');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.selector).toBe(b[0]!.selector);
    expect(a[0]!.selector).toBe('.a, .b');
  });

  it('comments/strings containing fake property text do not count', () => {
    const css = '/* position: fixed; */\n.clean { color: red; }\n';
    expect(scanFixedPositionDeclarations(css)).toEqual([]);
  });

  it('multiline selectors/declarations parse correctly', () => {
    const css = [
      '.multi-a,',
      '.multi-b {',
      '  position:',
      '    fixed;',
      '  inset: 0;',
      '}',
    ].join('\n');
    const found = scanFixedPositionDeclarations(css);
    expect(found).toHaveLength(1);
    expect(found[0]!.selector).toBe('.multi-a, .multi-b');
  });

  // #592 review pass 2: the scanner used to record only the NEAREST
  // enclosing at-rule, so a rule nested under TWO at-rules (`@supports` >
  // `@media`) produced the identical fingerprint as being nested under the
  // inner one alone.
  it('records the FULL chain of nested at-rules, outermost first, joined with " > "', () => {
    const css = '@supports (display: grid) {\n@media (max-width: 768px) {\n  .x { position: fixed; }\n}\n}\n';
    const found = scanFixedPositionDeclarations(css);
    expect(found).toHaveLength(1);
    expect(found[0]!.atRule).toBe('@supports (display: grid) > @media (max-width: 768px)');
  });
});

// ── Fixed-position sabotage cases ───────────────────────────────────────────

describe('#592 shell-fixed-position: sabotage (each must fail)', () => {
  it('a new root selector with position: fixed fails', () => {
    const found = findShellFixedPositionViolations('.sabotage-root { position: fixed; }', 'src/styles.css');
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('shell-fixed-position');
  });

  it('a new selector under @media fails', () => {
    const css = '@media (max-width: 768px) {\n  .sabotage-media { position: fixed; }\n}\n';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1);
  });

  it('a new selector under another nested at-rule fails', () => {
    const css = '@supports (display: grid) {\n  .sabotage-supports { position: fixed; }\n}\n';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1);
  });

  it('adding another selector to an approved selector group changes the key and fails', () => {
    const css = '.auth-host, .sabotage-appended { position: fixed; inset: 0; }';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain('.auth-host, .sabotage-appended');
  });

  it("a new selector with an approved-looking name (another '*-overlay') fails — no fuzzy name heuristic", () => {
    const found = findShellFixedPositionViolations('.sabotage-overlay { position: fixed; }', 'src/styles.css');
    expect(found).toHaveLength(1);
  });

  // P1 (accepted, PR #672 review pass 1): the prior check was a `.some(...)`
  // membership test with no count, so a duplicate of an already-approved
  // fingerprint silently passed.
  it('a duplicate of an already-approved selector/at-rule fails (count-based, not membership-only)', () => {
    const css = '.auth-host { position: fixed; }\n.auth-host { position: fixed; }\n';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1); // only the SECOND, excess occurrence
    expect(found[0]!.rule).toBe('shell-fixed-position');
    expect(found[0]!.detail).toContain('duplicates');
  });

  it('a THIRD occurrence of an already-approved-for-2 selector still only flags the excess one(s)', () => {
    // .fm-overlay/.fm-dialog-backdrop etc. are each approved for exactly 1 —
    // reuse .auth-host (also approved for exactly 1) three times: 2 excess.
    const css = Array(3).fill('.auth-host { position: fixed; }').join('\n');
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(2);
  });

  // #592 review pass 2: wrapping the APPROVED mobile `.inspector-host` rule
  // in a brand-new OUTER at-rule is a real, behavior-changing structural
  // edit (the rule now only applies when the outer at-rule also matches),
  // but the prior nearest-only fingerprint made it indistinguishable from
  // the unwrapped, already-approved baseline entry.
  it('wrapping the approved mobile .inspector-host rule in an additional outer at-rule fails', () => {
    const css = '@supports (display: grid) {\n@media (max-width: 768px) {\n  .inspector-host { position: fixed; inset: 0; }\n}\n}\n';
    const found = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('shell-fixed-position');
    expect(found[0]!.detail).toContain('.inspector-host');
  });
});

// ── Fixed-position missing-baseline-entry sabotage (P1, PR #672 review pass 1) ──
// The reverse direction: an approved fingerprint disappearing from the CSS
// entirely used to leave stale permission for its silent reintroduction,
// since nothing ever checked it. Meaningful only against the real, complete
// stylesheet (see `findShellFixedPositionMissingBaselineViolations`'s own
// doc comment) — these tests read the REAL `src/styles.css` and remove one
// approved rule from it, rather than using a small synthetic snippet.

describe('#592 shell-fixed-position: missing-baseline-entry sabotage (each must fail)', () => {
  const realStylesCss = readFileSync(join(root, 'src/styles.css'), 'utf8');

  it('the real, complete stylesheet has zero missing-baseline violations (sanity check)', () => {
    expect(findShellFixedPositionMissingBaselineViolations(realStylesCss, 'src/styles.css')).toEqual([]);
  });

  it('removing the one approved .auth-host rule from the real stylesheet is flagged as missing', () => {
    const withoutAuthHost = realStylesCss.replace(/\.auth-host\s*\{[^}]*\}/, '');
    // Sanity: the removal actually happened (otherwise this test would prove
    // nothing about the missing-entry check at all).
    expect(withoutAuthHost).not.toContain('.auth-host {');
    const found = findShellFixedPositionMissingBaselineViolations(withoutAuthHost, 'src/styles.css');
    const authHostMissing = found.find((v) => v.detail.includes('.auth-host') && v.detail.includes('none remain'));
    expect(authHostMissing).toBeDefined();
    expect(authHostMissing!.rule).toBe('shell-fixed-position');
  });

  it('a completely empty stylesheet flags every approved entry as missing', () => {
    const found = findShellFixedPositionMissingBaselineViolations('', 'src/styles.css');
    expect(found.length).toBeGreaterThan(1);
    expect(found.every((v) => v.rule === 'shell-fixed-position')).toBe(true);
  });

  // #592 review pass 2: wrapping the real, unmodified mobile `.inspector-host`
  // rule in an additional nested at-rule changes its full enclosing-at-rule
  // CHAIN — a real structural/behavioral change (the rule now only applies
  // when the new at-rule ALSO matches) — so the ORIGINAL baseline fingerprint
  // (single `@media (max-width: 768px)`) must be reported missing, exactly
  // like an outright removal.
  it('wrapping the real .inspector-host rule in an additional nested at-rule flags the original fingerprint as missing', () => {
    const inspectorHostRuleMatch = realStylesCss.match(/\.inspector-host\s*\{[^}]*position:\s*fixed[^}]*\}/);
    expect(inspectorHostRuleMatch).not.toBeNull(); // sanity: the real mobile rule was found
    const wrapped = realStylesCss.replace(
      inspectorHostRuleMatch![0],
      `@supports (display: grid) {\n${inspectorHostRuleMatch![0]}\n}`,
    );
    expect(wrapped).not.toBe(realStylesCss); // sanity: the wrap actually happened
    const missing = findShellFixedPositionMissingBaselineViolations(wrapped, 'src/styles.css')
      .find((v) => v.detail.includes('.inspector-host') && v.detail.includes('none remain'));
    expect(missing).toBeDefined();
    expect(missing!.rule).toBe('shell-fixed-position');
  });
});

// ── Diagnostic tests ─────────────────────────────────────────────────────────
// For at least one violation per rule: relative file, source line, rule id,
// offending selector/call/scope, and a concrete remediation are all present.

function lineOf(source: string, pos: number): number {
  return source.slice(0, pos).split('\n').length;
}

describe('#592 diagnostics are actionable', () => {
  it('shell-body-mount: file, line, rule, scope, and remediation are all present', () => {
    const source = wrapScope(['openRogueDiag'], 'document.body.appendChild(panel);');
    const [v] = shellViolations([{ filename: 'src/ui/_diag-a.ts', source }])
      .filter((x) => x.rule === 'shell-body-mount');
    expect(v).toBeDefined();
    expect(v!.filename).toBe('src/ui/_diag-a.ts');
    expect(lineOf(source, v!.pos)).toBe(source.slice(0, source.indexOf('document.body')).split('\n').length);
    expect(v!.rule).toBe('shell-body-mount');
    expect(v!.detail).toContain('openRogueDiag');
    expect(v!.detail).toMatch(/inspectorHost|SurfaceLifecycle|dialog\/popover|exception snapshot/);
  });

  it('shell-capture-escape: file, line, rule, scope, and remediation are all present', () => {
    const source = wrapScope(['openRogueDiag2'],
      "const onKey = (e) => { if (e.key === 'Escape') close(); };\ndocument.addEventListener('keydown', onKey, true);");
    const [v] = shellViolations([{ filename: 'src/ui/_diag-b.ts', source }])
      .filter((x) => x.rule === 'shell-capture-escape');
    expect(v).toBeDefined();
    expect(v!.filename).toBe('src/ui/_diag-b.ts');
    expect(lineOf(source, v!.pos)).toBe(source.slice(0, source.indexOf("document.addEventListener")).split('\n').length);
    expect(v!.rule).toBe('shell-capture-escape');
    expect(v!.detail).toContain('openRogueDiag2');
    expect(v!.detail).toMatch(/SurfaceLifecycle|documented exception/);
  });

  it('shell-fixed-position: file, line, rule, selector, and remediation are all present', () => {
    const css = '.header {}\n.sabotage-diag {\n  position: fixed;\n}\n';
    const [v] = findShellFixedPositionViolations(css, 'src/styles.css');
    expect(v).toBeDefined();
    expect(v!.filename).toBe('src/styles.css');
    expect(lineOf(css, v!.pos)).toBe(3);
    expect(v!.rule).toBe('shell-fixed-position');
    expect(v!.detail).toContain('.sabotage-diag');
    expect(v!.detail).toMatch(/docked composition|fixed-position snapshot/);
  });
});

// ── Sanity: unrelated files/rule shapes never contribute noise ─────────────

describe('#592 shell guardrails: files with none of the governed shapes stay clean', () => {
  it('a file with no Document-body mounts and no capture-Escape listeners is clean', () => {
    const source = 'export function pureHelper(a: number, b: number): number { return a + b; }\n';
    expect(shellViolations([{ filename: 'src/core/_unrelated.ts', source }])).toEqual([]);
  });

  it('a plain "body" local HTMLElement variable is never mistaken for Document.body', () => {
    const source = 'function f() { const body = document.createElement("div"); body.appendChild(child); }';
    const found = shellViolations([{ filename: 'src/ui/_not-document-body.ts', source }])
      .filter((v) => v.rule === 'shell-body-mount');
    expect(found).toEqual([]);
  });
});

// Typed-only compile-time proof the DTOs above are what the strict `.d.mts`
// boundary declares — never executed, just type-checked by `tsc --noEmit`.
function typeCheckOnly(): void {
  const decl: FixedPositionDeclaration = { selector: '.x', atRule: null, pos: 0 };
  const violation: SourceContractViolation = { rule: 'shell-body-mount', filename: 'x', pos: 0, detail: 'x' };
  const entry: ShellGuardrailSourceEntry = { filename: 'x', source: 'x' };
  void decl; void violation; void entry;
}
void typeCheckOnly;
